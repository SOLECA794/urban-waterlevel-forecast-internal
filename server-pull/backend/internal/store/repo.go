// 仓储查询层：station / forecast / alert / 配置表 / observation 等全部 SQL。
package store

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"time"
)

func jsonUnmarshal(s string, v any) error { return json.Unmarshal([]byte(s), v) }

func jsonMarshal(v any) ([]byte, error) { return json.Marshal(v) }

// ---------------- station ----------------

// ListStations 站点列表（enabledOnly 时仅启用站）。
func (s *Store) ListStations(enabledOnly bool) ([]StationRow, error) {
	q := `SELECT * FROM station`
	if enabledOnly {
		q += ` WHERE enabled=1`
	}
	q += ` ORDER BY station_id`
	var rows []StationRow
	return rows, s.DB.Select(&rows, q)
}

// GetStation 按 ID 取站点。
func (s *Store) GetStation(id int64) (*StationRow, error) {
	var r StationRow
	if err := s.DB.Get(&r, `SELECT * FROM station WHERE station_id=?`, id); err != nil {
		return nil, err
	}
	return &r, nil
}

// CreateStation 新建站点。
func (s *Store) CreateStation(r *StationRow) (int64, error) {
	res, err := s.DB.Exec(`INSERT INTO station
		(station_code, station_name, location, kind, source_id,
		 threshold_blue, threshold_yellow, threshold_orange, threshold_red,
		 base_level, response_k, longitude, latitude, enabled, create_time, update_time)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		r.StationCode, r.StationName, r.Location, r.Kind, r.SourceID,
		r.ThresholdBlue, r.ThresholdYellow, r.ThresholdOrange, r.ThresholdRed,
		r.BaseLevel, r.ResponseK, r.Longitude, r.Latitude, r.Enabled, time.Now().Unix(), time.Now().Unix())
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// UpdateStation 更新站点（动态拼列）。
func (s *Store) UpdateStation(id int64, fields map[string]any) error {
	if len(fields) == 0 {
		return nil
	}
	fields["update_time"] = time.Now().Unix()
	cols := make([]string, 0, len(fields))
	vals := make([]any, 0, len(fields)+1)
	for k, v := range fields {
		cols = append(cols, k+"=?")
		vals = append(vals, v)
	}
	vals = append(vals, id)
	_, err := s.DB.Exec(`UPDATE station SET `+strings.Join(cols, ", ")+` WHERE station_id=?`, vals...)
	return err
}

// DeleteStation 删除站点及其关联数据（同事务）。
func (s *Store) DeleteStation(id int64) error {
	tx, err := s.DB.Beginx()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, q := range []string{
		`DELETE FROM observation WHERE station_id=?`,
		`DELETE FROM future_truth WHERE station_id=?`,
		`DELETE FROM injected_event WHERE station_id=?`,
		`DELETE FROM forecast_point WHERE forecast_id IN (SELECT forecast_id FROM forecast WHERE station_id=?)`,
		`DELETE FROM forecast_decision WHERE forecast_id IN (SELECT forecast_id FROM forecast WHERE station_id=?)`,
		`DELETE FROM alert WHERE station_id=?`,
		`DELETE FROM forecast WHERE station_id=?`,
		`DELETE FROM station WHERE station_id=?`,
	} {
		if _, err := tx.Exec(q, id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ---------------- observation ----------------

// ReadObservations 读站点时序窗口 [start,end]（按 ts 升序）。
func (s *Store) ReadObservations(stationID int64, start, end time.Time) ([]ObservationRow, error) {
	var rows []ObservationRow
	err := s.DB.Select(&rows, `SELECT * FROM observation
		WHERE station_id=? AND ts>=? AND ts<=? ORDER BY ts`,
		stationID, start.Unix(), end.Unix())
	return rows, err
}

// LatestObservation 站点最新样本。
func (s *Store) LatestObservation(stationID int64) (*ObservationRow, error) {
	var r ObservationRow
	err := s.DB.Get(&r, `SELECT * FROM observation WHERE station_id=? ORDER BY ts DESC LIMIT 1`, stationID)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// UpsertObservations 批量写入观测（ON CONFLICT 覆盖，同 ts 取最新值语义）。
func (s *Store) UpsertObservations(rows []ObservationRow) error {
	if len(rows) == 0 {
		return nil
	}
	tx, err := s.DB.Beginx()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmt, err := tx.Preparex(`INSERT INTO observation (station_id, ts, level, rain_observed)
		VALUES (?,?,?,?) ON CONFLICT(station_id, ts) DO UPDATE SET level=excluded.level, rain_observed=excluded.rain_observed`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, r := range rows {
		if _, err := stmt.Exec(r.StationID, r.Ts, r.Level, r.RainObserved); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// FutureTruth 读取未来降雨真值映射。
func (s *Store) FutureTruth(stationID int64) (map[int64]float64, error) {
	rows := []struct {
		Ts       int64   `db:"ts"`
		RainTrue float64 `db:"rain_true"`
	}{}
	if err := s.DB.Select(&rows, `SELECT ts, rain_true FROM future_truth WHERE station_id=?`, stationID); err != nil {
		return nil, err
	}
	m := make(map[int64]float64, len(rows))
	for _, r := range rows {
		m[r.Ts] = r.RainTrue
	}
	return m, nil
}

// AddFutureTruth 注入事件时累加写入未来真值（groupby sum 语义）。
func (s *Store) AddFutureTruth(stationID int64, entries map[int64]float64) error {
	tx, err := s.DB.Beginx()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmt, err := tx.Preparex(`INSERT INTO future_truth (station_id, ts, rain_true) VALUES (?,?,?)
		ON CONFLICT(station_id, ts) DO UPDATE SET rain_true = rain_true + excluded.rain_true`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for ts, rain := range entries {
		if _, err := stmt.Exec(stationID, ts, rain); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// PruneFutureTruth 清理已过去的真值行（保留最近 24h 内，避免无限增长）。
func (s *Store) PruneFutureTruth(cutoff time.Time) error {
	_, err := s.DB.Exec(`DELETE FROM future_truth WHERE ts < ?`, cutoff.Unix())
	return err
}

// ---------------- forecast ----------------

// CreateForecast 新建预测主记录，返回 forecast_id。
func (s *Store) CreateForecast(r *ForecastRow) (int64, error) {
	res, err := s.DB.Exec(`INSERT INTO forecast
		(station_id, model_id, model_type, lead_hours, predict_time, horizon_end_time,
		 peak_level, peak_time, degraded, remark, create_time)
		VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		r.StationID, r.ModelID, r.ModelType, r.LeadHours, r.PredictTime, r.HorizonEndTime,
		r.PeakLevel, r.PeakTime, r.Degraded, r.Remark, time.Now().Unix())
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// AddForecastPoints 批量写预测逐点。
func (s *Store) AddForecastPoints(forecastID int64, points []ForecastPointRow) error {
	tx, err := s.DB.Beginx()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmt, err := tx.Preparex(`INSERT INTO forecast_point
		(forecast_id, lead_minutes, target_time, pred_level_raw, revision, pred_level, lower_bound, upper_bound)
		VALUES (?,?,?,?,?,?,?,?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, p := range points {
		if _, err := stmt.Exec(forecastID, p.LeadMinutes, p.TargetTime, p.PredLevelRaw,
			p.Revision, p.PredLevel, p.LowerBound, p.UpperBound); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// AddDecision 写入 D1–D5 决策记录。
func (s *Store) AddDecision(d *DecisionRow) error {
	_, err := s.DB.Exec(`INSERT INTO forecast_decision
		(forecast_id, selected_model, fusion_weights, revision_alpha, ci_scale, degraded, reason, create_time)
		VALUES (?,?,?,?,?,?,?,?)`,
		d.ForecastID, d.SelectedModel, d.FusionWeights, d.RevisionAlpha, d.CiScale, d.Degraded, d.Reason, time.Now().Unix())
	return err
}

// GetForecast 取预测主记录。
func (s *Store) GetForecast(id int64) (*ForecastRow, error) {
	var r ForecastRow
	if err := s.DB.Get(&r, `SELECT * FROM forecast WHERE forecast_id=?`, id); err != nil {
		return nil, err
	}
	return &r, nil
}

// ListForecastsForStation 站点预测列表（按 id 倒序分页）。
func (s *Store) ListForecastsForStation(stationID int64, lead *int, page, pageSize int) ([]ForecastRow, int, error) {
	where := `WHERE station_id=?`
	args := []any{stationID}
	if lead != nil {
		where += ` AND lead_hours=?`
		args = append(args, *lead)
	}
	var total int
	if err := s.DB.Get(&total, `SELECT COUNT(*) FROM forecast `+where, args...); err != nil {
		return nil, 0, err
	}
	args = append(args, pageSize, (page-1)*pageSize)
	var rows []ForecastRow
	err := s.DB.Select(&rows, `SELECT * FROM forecast `+where+` ORDER BY forecast_id DESC LIMIT ? OFFSET ?`, args...)
	return rows, total, err
}

// GetForecastPoints 预测逐点。
func (s *Store) GetForecastPoints(forecastID int64) ([]ForecastPointRow, error) {
	var rows []ForecastPointRow
	err := s.DB.Select(&rows, `SELECT * FROM forecast_point WHERE forecast_id=? ORDER BY lead_minutes`, forecastID)
	return rows, err
}

// GetDecision 预测决策。
func (s *Store) GetDecision(forecastID int64) (*DecisionRow, error) {
	var d DecisionRow
	if err := s.DB.Get(&d, `SELECT * FROM forecast_decision WHERE forecast_id=? ORDER BY decision_id DESC LIMIT 1`, forecastID); err != nil {
		return nil, err
	}
	return &d, nil
}

// RecentRMSEForStation 近 20 条带 RMSE 的预测平均（无记录返回 nil）。
func (s *Store) RecentRMSEForStation(stationID int64) (*float64, error) {
	var rows []*float64
	if err := s.DB.Select(&rows, `SELECT rmse FROM forecast
		WHERE station_id=? AND rmse IS NOT NULL ORDER BY forecast_id DESC LIMIT 20`, stationID); err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	sum := 0.0
	for _, v := range rows {
		sum += *v
	}
	avg := sum / float64(len(rows))
	return &avg, nil
}

// PendingActualPoints 已到期未回填的逐点（limit 2000）。
func (s *Store) PendingActualPoints(now time.Time, limit int) ([]ForecastPointRow, error) {
	var rows []ForecastPointRow
	err := s.DB.Select(&rows, `SELECT fp.* FROM forecast_point fp
		JOIN forecast f ON f.forecast_id = fp.forecast_id
		WHERE fp.actual_level IS NULL AND fp.target_time <= ?
		ORDER BY fp.forecast_id DESC LIMIT ?`, now.Unix(), limit)
	return rows, err
}

// BackfillActual 回填逐点实况并计算预测级 RMSE/MAE（≥3 对才更新主记录）。
func (s *Store) BackfillActual(updates []struct {
	ForecastID  int64
	LeadMinutes int
	Actual      float64
}) (int, error) {
	if len(updates) == 0 {
		return 0, nil
	}
	tx, err := s.DB.Beginx()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	stmt, err := tx.Preparex(`UPDATE forecast_point SET actual_level=? WHERE forecast_id=? AND lead_minutes=?`)
	if err != nil {
		return 0, err
	}
	defer stmt.Close()
	fcstSums := map[int64]*struct{ se, ae float64; n int }{}
	for _, u := range updates {
		if _, err := stmt.Exec(u.Actual, u.ForecastID, u.LeadMinutes); err != nil {
			return 0, err
		}
		agg, ok := fcstSums[u.ForecastID]
		if !ok {
			agg = &struct {
				se, ae float64
				n      int
			}{}
			fcstSums[u.ForecastID] = agg
		}
		agg.n++ // 回填计数（误差在读取侧统一计算）
	}
	// 逐 forecast 读取已回填对，计算 RMSE/MAE
	nDone := 0
	for fid := range fcstSums {
		var pts []ForecastPointRow
		if err := tx.Select(&pts, `SELECT * FROM forecast_point
			WHERE forecast_id=? AND actual_level IS NOT NULL`, fid); err != nil {
			return 0, err
		}
		if len(pts) < 3 {
			continue
		}
		var se, ae float64
		for _, p := range pts {
			d := p.PredLevel - *p.ActualLevel
			se += d * d
			ae += d
			if d < 0 {
				ae -= 0 // 保持绝对值语义
			}
		}
		ae = 0
		for _, p := range pts {
			d := p.PredLevel - *p.ActualLevel
			if d < 0 {
				d = -d
			}
			ae += d
		}
		rmse := sqrtF(se / float64(len(pts)))
		mae := ae / float64(len(pts))
		if _, err := tx.Exec(`UPDATE forecast SET rmse=?, mae=? WHERE forecast_id=?`, rmse, mae, fid); err != nil {
			return 0, err
		}
		nDone++
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return len(updates), nil
}

func sqrtF(v float64) float64 { return math.Sqrt(v) }

// ---------------- alert ----------------

// CreateAlert 新建预警，返回 alert_id。
func (s *Store) CreateAlert(r *AlertRow) (int64, error) {
	res, err := s.DB.Exec(`INSERT INTO alert
		(station_id, forecast_id, level, reason, peak_level, peak_time,
		 lead_minutes_advantage, is_reference, lead_hours, alert_time, status,
		 duration_min, trend)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		r.StationID, r.ForecastID, r.Level, r.Reason, r.PeakLevel, r.PeakTime,
		r.LeadMinutesAdvantage, r.IsReference, r.LeadHours, r.AlertTime, r.Status,
		r.DurationMin, r.Trend)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// GetAlert 取预警。
func (s *Store) GetAlert(id int64) (*AlertRow, error) {
	var r AlertRow
	if err := s.DB.Get(&r, `SELECT * FROM alert WHERE alert_id=?`, id); err != nil {
		return nil, err
	}
	return &r, nil
}

// ListAlerts 预警列表（status/level/station 过滤，分页，倒序）。
func (s *Store) ListAlerts(status, levelKey *string, stationID *int64, page, pageSize int) ([]AlertRow, int, error) {
	where, args := ` WHERE 1=1`, []any{}
	if status != nil && *status != "" {
		where += ` AND status=?`
		args = append(args, *status)
	}
	if levelKey != nil && *levelKey != "" {
		where += ` AND level=?`
		args = append(args, *levelKey)
	}
	if stationID != nil {
		where += ` AND station_id=?`
		args = append(args, *stationID)
	}
	var total int
	if err := s.DB.Get(&total, `SELECT COUNT(*) FROM alert`+where, args...); err != nil {
		return nil, 0, err
	}
	args = append(args, pageSize, (page-1)*pageSize)
	var rows []AlertRow
	err := s.DB.Select(&rows, `SELECT * FROM alert`+where+` ORDER BY alert_id DESC LIMIT ? OFFSET ?`, args...)
	return rows, total, err
}

// ActiveAlertsForStation 站点生效预警（active/confirmed/published）。
func (s *Store) ActiveAlertsForStation(stationID int64) ([]AlertRow, error) {
	var rows []AlertRow
	err := s.DB.Select(&rows, `SELECT * FROM alert
		WHERE station_id=? AND status IN ('active','confirmed','published') ORDER BY alert_id DESC`, stationID)
	return rows, err
}

// UpdateAlert 更新预警字段。
func (s *Store) UpdateAlert(id int64, fields map[string]any) error {
	if len(fields) == 0 {
		return nil
	}
	cols := make([]string, 0, len(fields))
	vals := make([]any, 0, len(fields)+1)
	for k, v := range fields {
		cols = append(cols, k+"=?")
		vals = append(vals, v)
	}
	vals = append(vals, id)
	_, err := s.DB.Exec(`UPDATE alert SET `+strings.Join(cols, ", ")+` WHERE alert_id=?`, vals...)
	return err
}

// ResolveStale 解除过期生效预警（resolve_minutes 前仍 active 的全部 resolved），返回条数。
func (s *Store) ResolveStale(stationID int64, cutoff time.Time) (int, error) {
	res, err := s.DB.Exec(`UPDATE alert SET status='resolved', resolve_time=?
		WHERE station_id=? AND status IN ('active','confirmed') AND alert_time <= ?`,
		time.Now().Unix(), stationID, cutoff.Unix())
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

// AlertStats 预警统计（按状态/等级）。
func (s *Store) AlertStats() (map[string]int, map[string]int, error) {
	byStatus := map[string]int{}
	rows := []struct {
		Status string `db:"status"`
		N      int    `db:"n"`
	}{}
	if err := s.DB.Select(&rows, `SELECT status, COUNT(*) n FROM alert GROUP BY status`); err != nil {
		return nil, nil, err
	}
	for _, r := range rows {
		byStatus[r.Status] = r.N
	}
	byLevel := map[string]int{}
	rows2 := []struct {
		Level string `db:"level"`
		N     int    `db:"n"`
	}{}
	if err := s.DB.Select(&rows2, `SELECT level, COUNT(*) n FROM alert GROUP BY level`); err != nil {
		return nil, nil, err
	}
	for _, r := range rows2 {
		byLevel[r.Level] = r.N
	}
	return byStatus, byLevel, nil
}

// ---------------- 配置表 ----------------

// AlertLevels 等级配置（按 rank 升序）。
func (s *Store) AlertLevels() ([]AlertLevelRow, error) {
	var rows []AlertLevelRow
	err := s.DB.Select(&rows, `SELECT * FROM alert_level_config ORDER BY rank`)
	return rows, err
}

// EnabledAlertLevels 启用的等级配置。
func (s *Store) EnabledAlertLevels() ([]AlertLevelRow, error) {
	var rows []AlertLevelRow
	err := s.DB.Select(&rows, `SELECT * FROM alert_level_config WHERE enabled=1 ORDER BY rank`)
	return rows, err
}

// ReplaceAlertLevels 全量替换等级配置（等级数量 3–5 校验由调用方做）。
func (s *Store) ReplaceAlertLevels(rows []AlertLevelRow) error {
	tx, err := s.DB.Beginx()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM alert_level_config`); err != nil {
		return err
	}
	for _, l := range rows {
		if _, err := tx.Exec(`INSERT INTO alert_level_config
			(rank, name, level_key, color, water_level_threshold, duration_threshold, description, enabled)
			VALUES (?,?,?,?,?,?,?,?)`,
			l.Rank, l.Name, l.LevelKey, l.Color, l.WaterLevelThreshold, l.DurationThreshold, l.Description, l.Enabled); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// LeadConfigs 预见期配置。
func (s *Store) LeadConfigs() ([]LeadConfigRow, error) {
	var rows []LeadConfigRow
	err := s.DB.Select(&rows, `SELECT * FROM forecast_lead_config ORDER BY lead_hours`)
	return rows, err
}

// ReplaceLeadConfigs 全量替换预见期配置。
func (s *Store) ReplaceLeadConfigs(rows []LeadConfigRow) error {
	tx, err := s.DB.Beginx()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM forecast_lead_config`); err != nil {
		return err
	}
	for _, l := range rows {
		if _, err := tx.Exec(`INSERT INTO forecast_lead_config (lead_hours, enabled, default_weight, is_reserved)
			VALUES (?,?,?,?)`, l.LeadHours, l.Enabled, l.DefaultWeight, l.IsReserved); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// PublishChannels 渠道列表。
func (s *Store) PublishChannels() ([]PublishChannelRow, error) {
	var rows []PublishChannelRow
	err := s.DB.Select(&rows, `SELECT * FROM publish_channel ORDER BY id`)
	return rows, err
}

// ReplacePublishChannels 全量替换渠道配置。
func (s *Store) ReplacePublishChannels(rows []PublishChannelRow) error {
	tx, err := s.DB.Beginx()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM publish_channel`); err != nil {
		return err
	}
	for _, c := range rows {
		if _, err := tx.Exec(`INSERT INTO publish_channel (id, type, name, enabled, endpoint, template)
			VALUES (?,?,?,?,?,?)`, c.ID, c.Type, c.Name, c.Enabled, c.Endpoint, c.Template); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Datasources 数据源配置列表。
func (s *Store) Datasources() ([]DatasourceConfigRow, error) {
	var rows []DatasourceConfigRow
	err := s.DB.Select(&rows, `SELECT * FROM datasource_config ORDER BY id`)
	return rows, err
}

// UpdateDatasource 更新数据源配置。
func (s *Store) UpdateDatasource(id int64, fields map[string]any) error {
	if len(fields) == 0 {
		return nil
	}
	fields["updated_at"] = time.Now().Unix()
	cols := make([]string, 0, len(fields))
	vals := make([]any, 0, len(fields)+1)
	for k, v := range fields {
		cols = append(cols, k+"=?")
		vals = append(vals, v)
	}
	vals = append(vals, id)
	_, err := s.DB.Exec(`UPDATE datasource_config SET `+strings.Join(cols, ", ")+` WHERE id=?`, vals...)
	return err
}

// ---------------- publish_record ----------------

// AddPublishRecord 写发布记录。
func (s *Store) AddPublishRecord(r *PublishRecordRow) (int64, error) {
	res, err := s.DB.Exec(`INSERT INTO publish_record (alert_id, channel_id, content, published_at)
		VALUES (?,?,?,?)`, r.AlertID, r.ChannelID, r.Content, r.PublishedAt)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// ListPublishRecords 发布记录（倒序分页）。
func (s *Store) ListPublishRecords(alertID *int64, page, pageSize int) ([]PublishRecordRow, int, error) {
	where, args := ` WHERE 1=1`, []any{}
	if alertID != nil {
		where += ` AND alert_id=?`
		args = append(args, *alertID)
	}
	var total int
	if err := s.DB.Get(&total, `SELECT COUNT(*) FROM publish_record`+where, args...); err != nil {
		return nil, 0, err
	}
	args = append(args, pageSize, (page-1)*pageSize)
	var rows []PublishRecordRow
	err := s.DB.Select(&rows, `SELECT * FROM publish_record`+where+` ORDER BY record_id DESC LIMIT ? OFFSET ?`, args...)
	return rows, total, err
}

// UpdatePublishRecordContent 更新发布记录内容（用于修复乱码）。
func (s *Store) UpdatePublishRecordContent(recordID int64, content string) error {
	_, err := s.DB.Exec(`UPDATE publish_record SET content=? WHERE record_id=?`, content, recordID)
	return err
}

// PublishRecordsForAlerts 批量取预警的发布记录。
func (s *Store) PublishRecordsForAlerts(alertIDs []int64) (map[int64][]PublishRecordRow, error) {
	out := map[int64][]PublishRecordRow{}
	if len(alertIDs) == 0 {
		return out, nil
	}
	ids := make([]string, len(alertIDs))
	for i, id := range alertIDs {
		ids[i] = fmt.Sprintf("%d", id)
	}
	var rows []PublishRecordRow
	q := `SELECT * FROM publish_record WHERE alert_id IN (` + strings.Join(ids, ",") + `) ORDER BY record_id`
	if err := s.DB.Select(&rows, q); err != nil {
		return nil, err
	}
	for _, r := range rows {
		out[r.AlertID] = append(out[r.AlertID], r)
	}
	return out, nil
}

// ---------------- model / task / calibration ----------------

// ListModels 模型版本列表。
func (s *Store) ListModels() ([]ModelRow, error) {
	var rows []ModelRow
	err := s.DB.Select(&rows, `SELECT * FROM model ORDER BY model_id`)
	return rows, err
}

// GetModel 取模型。
func (s *Store) GetModel(id int64) (*ModelRow, error) {
	var r ModelRow
	if err := s.DB.Get(&r, `SELECT * FROM model WHERE model_id=?`, id); err != nil {
		return nil, err
	}
	return &r, nil
}

// GetActiveModel 激活模型。
func (s *Store) GetActiveModel() (*ModelRow, error) {
	var r ModelRow
	if err := s.DB.Get(&r, `SELECT * FROM model WHERE active=1 LIMIT 1`); err != nil {
		return nil, err
	}
	return &r, nil
}

// ActivateModel 激活指定模型（其余置 inactive）。
func (s *Store) ActivateModel(id int64) error {
	tx, err := s.DB.Beginx()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE model SET active=0 WHERE active=1`); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE model SET active=1, update_time=? WHERE model_id=?`, time.Now().Unix(), id); err != nil {
		return err
	}
	return tx.Commit()
}

// SaveCalibration 写回标定参数到 model.algorithm_config。
func (s *Store) SaveCalibration(modelID, stationID int64, params map[string]any,
	metrics map[string]any) error {
	row, err := s.GetModel(modelID)
	if err != nil {
		return err
	}
	cfgObj := map[string]any{}
	if row.AlgorithmConfig != nil && *row.AlgorithmConfig != "" {
		_ = jsonUnmarshal(*row.AlgorithmConfig, &cfgObj)
	}
	calib, _ := cfgObj["calibration"].(map[string]any)
	if calib == nil {
		calib = map[string]any{}
	}
	calib[fmt.Sprintf("%d", stationID)] = map[string]any{
		"params": params, "metrics": metrics,
		"calibrated_at": time.Now().Format(time.RFC3339),
	}
	cfgObj["calibration"] = calib
	b, err := jsonMarshal(cfgObj)
	if err != nil {
		return err
	}
	_, err = s.DB.Exec(`UPDATE model SET algorithm_config=?, update_time=? WHERE model_id=?`,
		string(b), time.Now().Unix(), modelID)
	return err
}

// CreateTask 新建长任务。
func (s *Store) CreateTask(taskType, requestJSON, status string) (int64, error) {
	res, err := s.DB.Exec(`INSERT INTO task (task_type, status, request_json, create_time)
		VALUES (?,?,?,?)`, taskType, status, requestJSON, time.Now().Unix())
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// GetTask 取任务。
func (s *Store) GetTask(id int64) (*TaskRow, error) {
	var r TaskRow
	if err := s.DB.Get(&r, `SELECT * FROM task WHERE task_id=?`, id); err != nil {
		return nil, err
	}
	return &r, nil
}

// CreateCalibration 新建校准记录。
func (s *Store) CreateCalibration(r *CalibrationRow) (int64, error) {
	res, err := s.DB.Exec(`INSERT INTO calibration_record
		(type, target, before_json, after_json, preview_json, status, executed_by, note, created_at)
		VALUES (?,?,?,?,?,?,?,?,?)`,
		r.Type, r.Target, r.BeforeJSON, r.AfterJSON, r.PreviewJSON, r.Status, r.ExecutedBy, r.Note, time.Now().Unix())
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// ListCalibrations 校准记录列表（倒序分页）。
func (s *Store) ListCalibrations(page, pageSize int) ([]CalibrationRow, int, error) {
	var total int
	if err := s.DB.Get(&total, `SELECT COUNT(*) FROM calibration_record`); err != nil {
		return nil, 0, err
	}
	var rows []CalibrationRow
	err := s.DB.Select(&rows, `SELECT * FROM calibration_record ORDER BY id DESC LIMIT ? OFFSET ?`,
		pageSize, (page-1)*pageSize)
	return rows, total, err
}

// ---------------- injected_event ----------------

// SaveInjectedEvent 持久化注入事件。
func (s *Store) SaveInjectedEvent(r *InjectedEventRow) error {
	_, err := s.DB.Exec(`INSERT OR REPLACE INTO injected_event
		(event_id, station_id, intensity, intensity_label, peak_mm_per_step, duration_minutes,
		 start_ts, end_ts, shape_json, injected_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
		r.EventID, r.StationID, r.Intensity, r.IntensityLabel, r.PeakMmPerStep, r.DurationMinutes,
		r.StartTs, r.EndTs, r.ShapeJSON, r.InjectedAt)
	return err
}

// ListInjectedEvents 注入事件（倒序）。
func (s *Store) ListInjectedEvents(limit int) ([]InjectedEventRow, error) {
	var rows []InjectedEventRow
	err := s.DB.Select(&rows, `SELECT * FROM injected_event ORDER BY injected_at DESC LIMIT ?`, limit)
	return rows, err
}


// GetAlertByForecast 取预警（按预测记录关联，取最新一条）。
func (s *Store) GetAlertByForecast(forecastID int64) (*AlertRow, error) {
	var r AlertRow
	err := s.DB.Get(&r, `SELECT * FROM alert WHERE forecast_id=? ORDER BY alert_id DESC LIMIT 1`, forecastID)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// CountStations 站点计数（健康检查）。
func (s *Store) CountStations() (int, error) {
	var n int
	if err := s.DB.Get(&n, `SELECT COUNT(*) FROM station`); err != nil {
		return 0, err
	}
	return n, nil
}

// CountForecasts 预测记录计数（健康检查）。
func (s *Store) CountForecasts() (int, error) {
	var n int
	if err := s.DB.Get(&n, `SELECT COUNT(*) FROM forecast`); err != nil {
		return 0, err
	}
	return n, nil
}
