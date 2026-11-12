// 研判预警服务（FR-4）：阈值判定 / 联合研判 / 提前量 / 参考级 / 去重 / 解除。
// 移植自 app/application/alert_service.py；差异（按架构文档）：
//   - 阈值来源从 station 固定四列改为动态等级表 alert_level_config（3–5 级、rank 0 起）；
//   - 状态机扩展 active→confirmed→published→resolved（+false_report）。
package service

import (
	"database/sql"
	"fmt"
	"time"

	"waterlog/backend/internal/config"
	"waterlog/backend/internal/errs"
	"waterlog/backend/internal/store"
)

// AlertService 预警服务。
type AlertService struct {
	cfg   config.AlertConfig
	store *store.Store
	bus   *Bus
}

// NewAlertService 构造。
func NewAlertService(cfg config.AlertConfig, st *store.Store, bus *Bus) *AlertService {
	return &AlertService{cfg: cfg, store: st, bus: bus}
}

// CurvePoint 预测曲线点（研判输入）。
type CurvePoint struct {
	T     time.Time
	Level float64
}

// Levels 启用的等级配置（rank 升序）。
func (a *AlertService) Levels() ([]store.AlertLevelRow, error) {
	return a.store.EnabledAlertLevels()
}

// Classify 峰值对应的最高预警等级（未超最低阈值 → nil）。
func (a *AlertService) Classify(peak float64, levels []store.AlertLevelRow) *store.AlertLevelRow {
	var hit *store.AlertLevelRow
	for i := range levels {
		if peak >= levels[i].WaterLevelThreshold {
			hit = &levels[i]
		}
	}
	return hit
}

// FirstCrossTime 预测曲线首次越过阈值的时间点。
func (a *AlertService) FirstCrossTime(points []CurvePoint, threshold float64) *time.Time {
	for i := range points {
		if points[i].Level >= threshold {
			t := points[i].T
			return &t
		}
	}
	return nil
}

// EvaluateAfterForecast 预测完成后基于修正后曲线研判（FR-4.1/4.3/4.4 + V1.4 联合研判）。
// 返回 nil 表示无预警（峰值回落）。
func (a *AlertService) EvaluateAfterForecast(station *store.StationRow, forecastID int64,
	points []CurvePoint, leadHours int) (*store.AlertRow, error) {
	levels, err := a.Levels()
	if err != nil {
		return nil, err
	}
	if len(levels) == 0 {
		return nil, fmt.Errorf("等级表为空，无法研判")
	}
	peak := 0.0
	var peakTime *time.Time
	if len(points) > 0 {
		peak = points[0].Level
		for _, p := range points[1:] {
			if p.Level > peak {
				peak = p.Level
			}
		}
		for _, p := range points {
			if p.Level == peak {
				t := p.T
				peakTime = &t
				break
			}
		}
	}
	// 起报时刻对齐预测曲线第一个点，而非 now——观测样本滞后时提前量不被截为 0
	tNow := time.Now()
	if len(points) > 0 {
		tNow = points[0].T
	}
	isReference := leadHours >= 6

	lvl := a.Classify(peak, levels)

	// ---- V1.4 升级：持续时间 + 变化趋势 联合研判（FR 2.2） ----
	durationMin, slope := 0, 0.0
	if lvl != nil {
		stepMin := 5
		above := 0
		for _, p := range points {
			if p.Level >= levels[0].WaterLevelThreshold {
				above++
			}
		}
		durationMin = above * stepMin
		// 后 1/3 段趋势斜率（m/步）
		start := len(points) * 2 / 3
		if start < 1 {
			start = 1
		}
		if len(points) > start {
			tail := points[start:]
			if len(tail) >= 2 {
				slope = (tail[len(tail)-1].Level - tail[0].Level) / float64(max(1, len(tail)-1))
			}
		}
		maxRank := levels[len(levels)-1].Rank
		rank := lvl.Rank
		if durationMin >= 60 && rank < maxRank {
			rank++
		}
		if slope > 0.02 && rank < maxRank {
			rank++
		}
		if slope < -0.01 && rank > 0 {
			rank--
		}
		for i := range levels {
			if levels[i].Rank == rank {
				lvl = &levels[i]
				break
			}
		}
	}

	if lvl == nil {
		// 峰值回落 → 解除过期生效预警（FR-4.4 简化）
		cutoff := time.Now().Add(-time.Duration(a.cfg.ResolveMinutes) * time.Minute)
		if n, err := a.store.ResolveStale(station.StationID, cutoff); err == nil && n > 0 {
			a.bus.Publish("alert.resolved", map[string]any{"stationId": station.StationID, "count": n})
		}
		return nil, nil
	}

	crossing := a.FirstCrossTime(points, lvl.WaterLevelThreshold)
	var advantage *int
	if crossing != nil {
		v := int(max(0, int(crossing.Sub(tNow).Minutes())))
		advantage = &v
	}
	levelName := map[string]string{"blue": "蓝色", "yellow": "黄色", "orange": "橙色", "red": "红色"}[lvl.LevelKey]
	if levelName == "" {
		levelName = lvl.Name
	}
	pt := "—"
	if peakTime != nil {
		pt = peakTime.Format("15:04")
	}
	reason := fmt.Sprintf("预测峰值 %.2f m 于 %s 超过%s阈值 %.2f m（预见期 %dh，口径：水位高程 m）",
		peak, pt, levelName, lvl.WaterLevelThreshold, leadHours)

	// ---- 去重：窗口内同站同参考级，已有同级或更高级 → 更新；新等级更高 → 升级 ----
	existing, err := a.store.ActiveAlertsForStation(station.StationID)
	if err != nil {
		return nil, err
	}
	dedupCutoff := time.Now().Add(-time.Duration(a.cfg.DedupMinutes) * time.Minute)
	rankOf := func(levelKey string) int {
		for _, l := range levels {
			if l.LevelKey == levelKey {
				return l.Rank
			}
		}
		return 0
	}
	for i := range existing {
		e := existing[i]
		if e.IsReference != isReference {
			continue
		}
		if e.AlertTime < dedupCutoff.Unix() {
			continue
		}
		if rankOf(e.Level) >= lvl.Rank {
			if err := a.store.UpdateAlert(e.AlertID, map[string]any{
				"forecast_id": forecastID, "peak_level": peak,
				"peak_time":   timeToUnix(peakTime), "lead_minutes_advantage": advPtr(advantage),
				"reason": reason, "duration_min": durationMin, "trend": slope,
			}); err != nil {
				return nil, err
			}
			a.bus.Publish("alert.updated", map[string]any{"alertId": e.AlertID})
			return a.store.GetAlert(e.AlertID)
		}
		// 新等级更高 → 升级原预警（FR-4.2 简化：不要求持续时长）
		if err := a.store.UpdateAlert(e.AlertID, map[string]any{
			"level": lvl.LevelKey, "forecast_id": forecastID, "peak_level": peak,
			"peak_time": timeToUnix(peakTime), "lead_minutes_advantage": advPtr(advantage),
			"reason": reason + "（等级上调）", "duration_min": durationMin, "trend": slope,
		}); err != nil {
			return nil, err
		}
		a.bus.Publish("alert.upgraded", map[string]any{"alertId": e.AlertID, "level": lvl.LevelKey})
		return a.store.GetAlert(e.AlertID)
	}

	alertTime := time.Now()
	newID, err := a.store.CreateAlert(&store.AlertRow{
		StationID: station.StationID, ForecastID: &forecastID, Level: lvl.LevelKey,
		Reason: &reason, PeakLevel: &peak, PeakTime: timeToUnix(peakTime),
		LeadMinutesAdvantage: advantage, IsReference: isReference, LeadHours: &leadHours,
		AlertTime: alertTime.Unix(), Status: "active",
		DurationMin: &durationMin, Trend: &slope,
	})
	if err != nil {
		return nil, err
	}
	a.bus.Publish("alert.created", map[string]any{"alertId": newID, "stationId": station.StationID, "level": lvl.LevelKey})
	return a.store.GetAlert(newID)
}

// 状态机流转：确认 / 解除 / 误报。
// Confirm active→confirmed；Resolve →resolved；FalseReport →false_report。

// ConfirmAlert 确认预警。
func (a *AlertService) ConfirmAlert(id int64) (*store.AlertRow, error) {
	return a.transition(id, "confirmed", "active")
}

// ResolveAlert 解除预警。
func (a *AlertService) ResolveAlert(id int64) (*store.AlertRow, error) {
	al, err := a.mustExist(id)
	if err != nil {
		return nil, err
	}
	if err := a.store.UpdateAlert(id, map[string]any{
		"status": "resolved", "resolve_time": time.Now().Unix(),
	}); err != nil {
		return nil, err
	}
	a.bus.Publish("alert.resolved", map[string]any{"alertId": id})
	return a.store.GetAlert(al.AlertID)
}

// FalseReportAlert 标记误报（带原因）。
func (a *AlertService) FalseReportAlert(id int64, reason string) (*store.AlertRow, error) {
	if reason == "" {
		reason = "未注明原因"
	}
	al, err := a.mustExist(id)
	if err != nil {
		return nil, err
	}
	if al.Status == "resolved" || al.Status == "false_report" {
		return nil, errs.New(errs.PARAM_INVALID, "预警已终结，不可标记误报")
	}
	if err := a.store.UpdateAlert(id, map[string]any{
		"status": "false_report", "false_report_reason": reason,
	}); err != nil {
		return nil, err
	}
	a.bus.Publish("alert.false_report", map[string]any{"alertId": id})
	return a.store.GetAlert(id)
}

func (a *AlertService) transition(id int64, to, from string) (*store.AlertRow, error) {
	al, err := a.mustExist(id)
	if err != nil {
		return nil, err
	}
	if from != "" && al.Status != from {
		return nil, errs.New(errs.PARAM_INVALID,
			fmt.Sprintf("预警状态为 %s，仅 %s 状态可执行该操作", al.Status, from))
	}
	if err := a.store.UpdateAlert(id, map[string]any{"status": to}); err != nil {
		return nil, err
	}
	return a.store.GetAlert(id)
}

type stateError struct{ cur, want string }

func (e *stateError) Error() string {
	return fmt.Sprintf("预警状态为 %s，仅 %s 状态可执行该操作", e.cur, e.want)
}

func (a *AlertService) mustExist(id int64) (*store.AlertRow, error) {
	al, err := a.store.GetAlert(id)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, errs.New(errs.RESOURCE_NOT_FOUND, "预警不存在")
		}
		return nil, err
	}
	return al, nil
}

func timeToUnix(t *time.Time) *int64 {
	if t == nil {
		return nil
	}
	v := t.Unix()
	return &v
}

func advPtr(v *int) any {
	if v == nil {
		return nil
	}
	return *v
}
