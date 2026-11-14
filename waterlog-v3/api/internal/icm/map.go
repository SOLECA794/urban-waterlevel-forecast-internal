package icm

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"waterlog-v3/api/internal/domain"
)

// ---------------------------------------------------------------- 编码映射
//
// 【事实】对方主键是 indexCode（设备）/ regionIndexCode（区域）/ cameraIndexCode（监控点），
// v3 内部主键是 site_id（S01~S10）。映射表按设计文档 §6.1 放在适配层，
// 不改 v3 的 SITES 与 builtinSites。
//
// EXT-POINT(DATASOURCE): 正式的点位编码对照表需对方提供设备台账后录入。
// 未录入前用「恒等映射」兜底，保证链路能跑通且结果可诊断（不会静默丢数据）。
type PointMap interface {
	SiteID(indexCode string) (string, bool)
}

// IdentityPointMap 恒等映射：indexCode 直接当 site_id 用。
type IdentityPointMap struct{}

func (IdentityPointMap) SiteID(indexCode string) (string, bool) {
	s := strings.TrimSpace(indexCode)
	return s, s != ""
}

// StaticPointMap 静态对照表，从环境变量 WL_ICM_POINT_MAP 读取，
// 格式：indexCode=siteId,indexCode2=siteId2（分号或逗号分隔均可）。
type StaticPointMap map[string]string

func (m StaticPointMap) SiteID(indexCode string) (string, bool) {
	v, ok := m[strings.TrimSpace(indexCode)]
	return v, ok && v != ""
}

// ParsePointMap 解析编码对照表。空串返回恒等映射。
func ParsePointMap(s string) PointMap {
	s = strings.TrimSpace(s)
	if s == "" {
		return IdentityPointMap{}
	}
	m := StaticPointMap{}
	for _, pair := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ';' || r == '\n' }) {
		kv := strings.SplitN(strings.TrimSpace(pair), "=", 2)
		if len(kv) == 2 && strings.TrimSpace(kv[0]) != "" && strings.TrimSpace(kv[1]) != "" {
			m[strings.TrimSpace(kv[0])] = strings.TrimSpace(kv[1])
		}
	}
	if len(m) == 0 {
		return IdentityPointMap{}
	}
	return m
}

// ---------------------------------------------------------------- 时间基准
//
// 【事实】v3 是 60 倍速仿真时钟（NowTS() = MAX(telemetry.ts)），
// 对方 monitorTime 是真实 ISO 8601 时间。两者不在同一时间轴上。
// 【约束】设计文档 §6.3：来自对方的数据必须用真实时间，
// 禁止把仿真时间当真实采集时间外发，反之亦然。
//
// 因此映射结果始终带 timeBasis 标注；是否写入 v3 由调用方显式决定，
// 本层不自动写库（默认 dry-run）。
type TimeBasis string

const (
	TimeBasisReal      TimeBasis = "real"      // 用 monitorTime 的真实 Unix 秒（生产 1 倍速）
	TimeBasisSimulated TimeBasis = "simulated" // 对齐到 v3 仿真时钟（验收与联调用）
)

type MapConfig struct {
	LevelItem string    // 水位监测项编码，默认取 Config.MonitorItem
	RainItem  string    // 雨量监测项编码，默认取 Config.MonitorItemRain；空 = 不取雨量
	Basis     TimeBasis // 默认 real
	// SimNow 仅在 simulated 基准下使用：返回 v3 当前仿真时钟（Unix 秒）。
	// 由调用方从 /api/health 或 store.NowTS() 取得，本层不自行猜测。
	SimNow func() int64
}

// MapReport 是映射过程的可诊断记录，避免"数据少了却不知道为什么"。
type MapReport struct {
	Input       int      `json:"input"`
	Output      int      `json:"output"`
	SkippedCode int      `json:"skipped_no_site_id"` // 编码映射不到
	SkippedTime int      `json:"skipped_bad_time"`   // monitorTime 解析失败
	SkippedVal  int      `json:"skipped_no_value"`   // 动态监测项缺失
	TimeBasis   string   `json:"timeBasis"`
	Warnings    []string `json:"warnings,omitempty"`
}

// MapRealtime 把 R1/R2 的监测记录转成 v3 已有的 domain.TelemetryBatch。
//
// 字段对应（对方 → v3）：
//
//	indexCode      → site_id（经 PointMap；EXT-POINT(DATASOURCE)）
//	monitorTime    → ts（真实 Unix 秒，或对齐仿真时钟）
//	{监测项编码}   → level（动态字段名，如 "wl"）
//	{雨量监测项}   → rain（可选）
//	—              → quality：对方原件无质量标记，默认 1（有效）
//	—              → rain_fc_1h / rain_fc_3h：对方无降水预报，填 0；
//	                 EXT-POINT(DATASOURCE): 真实气象/降水预报源接入后补齐
func MapRealtime(records []MonitorRecord, cfg Config, points PointMap, mc MapConfig) (domain.TelemetryBatch, MapReport) {
	if points == nil {
		points = IdentityPointMap{}
	}
	if mc.LevelItem == "" {
		mc.LevelItem = cfg.MonitorItem
	}
	if mc.RainItem == "" {
		mc.RainItem = cfg.MonitorItemRain
	}
	if mc.Basis == "" {
		mc.Basis = TimeBasisReal
	}

	rep := MapReport{Input: len(records), TimeBasis: string(mc.Basis)}
	rep.Warnings = append(rep.Warnings,
		"对方 monitorTime 为真实时间轴；v3 当前为 60x 仿真时钟，两者不可混用。",
		"默认 dry-run：映射结果需调用方显式确认后才写入 /api/ingest/telemetry。",
	)
	if mc.RainItem == "" {
		rep.Warnings = append(rep.Warnings, "未配置雨量监测项（WL_ICM_MONITOR_ITEM_RAIN），rain 填 0。")
	}
	rep.Warnings = append(rep.Warnings,
		"对方接口未返回降水预报与数据质量标记：rain_fc_1h/rain_fc_3h 填 0、quality 填 1；EXT-POINT(DATASOURCE) 真实气象源与质量治理接入后补齐。")

	// 同一批内按 indexCode + 时间稳定排序，保证仿真基准下对齐顺序可复现
	ordered := make([]MonitorRecord, len(records))
	copy(ordered, records)
	sort.SliceStable(ordered, func(i, j int) bool {
		if ordered[i].IndexCode != ordered[j].IndexCode {
			return ordered[i].IndexCode < ordered[j].IndexCode
		}
		return ordered[i].MonitorTime < ordered[j].MonitorTime
	})

	batch := domain.TelemetryBatch{Rows: make([]domain.TelemetryRow, 0, len(ordered))}
	simTS := int64(0)
	if mc.Basis == TimeBasisSimulated && mc.SimNow != nil {
		simTS = mc.SimNow()
	}

	for _, r := range ordered {
		siteID, ok := points.SiteID(r.IndexCode)
		if !ok {
			rep.SkippedCode++
			continue
		}
		level, ok := r.ValueOf(mc.LevelItem)
		if !ok {
			rep.SkippedVal++
			continue
		}

		var ts int64
		if mc.Basis == TimeBasisSimulated {
			ts = simTS // 整批对齐到当前仿真时刻，避免真实时间污染
		} else {
			t, err := ParseICMTime(r.MonitorTime)
			if err != nil {
				rep.SkippedTime++
				continue
			}
			ts = t.Unix()
		}

		rain := 0.0
		if mc.RainItem != "" {
			if v, ok := r.ValueOf(mc.RainItem); ok {
				rain = v
			}
		}
		batch.Rows = append(batch.Rows, domain.TelemetryRow{
			TS:       ts,
			SiteID:   siteID,
			Level:    level,
			Rain:     rain,
			Quality:  1,
			RainFc1h: 0,
			RainFc3h: 0,
		})
	}
	rep.Output = len(batch.Rows)
	return batch, rep
}

// UnixSeconds 是给调用方做时间换算的小工具（避免各处重复写 In().Unix()）。
func UnixSeconds(t time.Time) int64 { return t.Unix() }

// ValidateMapConfig 在启动前把明显配错的映射挡住，而不是等到数据全被跳过。
func ValidateMapConfig(cfg Config, mc MapConfig) error {
	item := mc.LevelItem
	if item == "" {
		item = cfg.MonitorItem
	}
	if strings.TrimSpace(item) == "" {
		return fmt.Errorf("水位监测项编码不能为空（WL_ICM_MONITOR_ITEM）")
	}
	if mc.Basis != "" && mc.Basis != TimeBasisReal && mc.Basis != TimeBasisSimulated {
		return fmt.Errorf("未知 timeBasis %q，只能是 real / simulated", mc.Basis)
	}
	return nil
}
