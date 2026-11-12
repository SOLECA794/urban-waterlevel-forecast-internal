// 种子数据：站点（stations.yaml 平移）、等级表、预见期、渠道、数据源、模型版本。
// 首次启动（空库）执行，存在即跳过。
package store

import (
	"fmt"
	"time"
)

// SeedStationDef 站点种子（与原 config/stations.yaml 逐字段平移）。
type SeedStationDef struct {
	Code, Name, Location, Kind string
	Thresholds                 [4]float64 // blue/yellow/orange/red
	Base, ResponseK            float64
	Lon, Lat                   float64
}

// SeedStations 6 站种子（具备不同响应特征）。
var SeedStations = []SeedStationDef{
	{"S001", "站前路低洼段", "站前路与建设大街交叉口", "low-lying", [4]float64{1.6, 1.9, 2.2, 2.5}, 1.2, 0.008, 120.155, 30.245},
	{"S002", "建设路下穿隧道", "建设路铁路下穿", "low-lying", [4]float64{1.5, 1.8, 2.1, 2.4}, 1.0, 0.008, 120.162, 30.252},
	{"S003", "城东河河道断面", "城东河桥上游 200m", "river", [4]float64{2.0, 2.4, 2.8, 3.2}, 1.6, 0.012, 120.185, 30.268},
	{"S004", "老城十字街", "老城区中山路十字街口", "low-lying", [4]float64{1.7, 2.0, 2.3, 2.6}, 1.3, 0.010, 120.172, 30.243},
	{"S005", "新区主干道", "高新区创新大道", "road", [4]float64{1.8, 2.2, 2.6, 3.0}, 1.4, 0.014, 120.208, 30.281},
	{"S006", "工业园区雨水泵站", "工业园区纬三路泵站", "pump", [4]float64{1.9, 2.3, 2.7, 3.1}, 1.5, 0.012, 120.225, 30.262},
}

// DefaultAlertLevels 默认 4 级预警等级（rank 从 0 起，与原型设置页/mock 口径一致）。
var DefaultAlertLevels = []AlertLevelRow{
	{Rank: 0, Name: "蓝色", LevelKey: "blue", Color: "#1890ff", WaterLevelThreshold: 1.8, DurationThreshold: 60, Description: strPtr("水位接近警戒，需关注"), Enabled: true},
	{Rank: 1, Name: "黄色", LevelKey: "yellow", Color: "#faad14", WaterLevelThreshold: 2.2, DurationThreshold: 90, Description: strPtr("可能出现积水，建议巡防"), Enabled: true},
	{Rank: 2, Name: "橙色", LevelKey: "orange", Color: "#fa8c16", WaterLevelThreshold: 2.6, DurationThreshold: 120, Description: strPtr("积水风险较高，需部署排涝"), Enabled: true},
	{Rank: 3, Name: "红色", LevelKey: "red", Color: "#f5222d", WaterLevelThreshold: 3.0, DurationThreshold: 150, Description: strPtr("严重内涝风险，立即响应"), Enabled: true},
}

// Seed 首次启动种子数据（各子项存在即跳过）。
func (s *Store) Seed(now time.Time) error {
	if err := s.seedSource(now); err != nil {
		return err
	}
	if err := s.seedStations(now); err != nil {
		return err
	}
	if err := s.seedModels(now); err != nil {
		return err
	}
	return s.seedConfigs(now)
}

func (s *Store) seedSource(now time.Time) error {
	var n int
	if err := s.DB.Get(&n, `SELECT COUNT(*) FROM source`); err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	_, err := s.DB.Exec(`INSERT INTO source (source_code, source_name, type, status, create_time, update_time)
		VALUES ('SIM-001', '模拟数据源（实况+预报双路）', 'simulated', 'STREAMING', ?, ?)`, now.Unix(), now.Unix())
	return err
}

func (s *Store) seedStations(now time.Time) error {
	var n int
	if err := s.DB.Get(&n, `SELECT COUNT(*) FROM station`); err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	var sourceID int64
	if err := s.DB.Get(&sourceID, `SELECT source_id FROM source LIMIT 1`); err != nil {
		return err
	}
	for _, d := range SeedStations {
		_, err := s.DB.Exec(`INSERT INTO station
			(station_code, station_name, location, kind, source_id,
			 threshold_blue, threshold_yellow, threshold_orange, threshold_red,
			 base_level, response_k, longitude, latitude, enabled, create_time, update_time)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
			d.Code, d.Name, d.Location, d.Kind, sourceID,
			d.Thresholds[0], d.Thresholds[1], d.Thresholds[2], d.Thresholds[3],
			d.Base, d.ResponseK, d.Lon, d.Lat, now.Unix(), now.Unix())
		if err != nil {
			return fmt.Errorf("种子站点 %s 失败: %w", d.Code, err)
		}
	}
	return nil
}

func (s *Store) seedModels(now time.Time) error {
	var n int
	if err := s.DB.Get(&n, `SELECT COUNT(*) FROM model`); err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	ts := now.Unix()
	rows := []struct{ name, ver, mtype, file string; active bool }{
		{"LinearResponse", "v1.0", "linear_response", "builtin", true},
		{"NonlinearRunoff", "v1.0", "nonlinear", "builtin", false},
		{"NaivePersistence", "v1.0", "naive", "builtin", false},
		{"LightGBM", "v0.1", "lgbm", "", false},
	}
	for _, r := range rows {
		if _, err := s.DB.Exec(`INSERT INTO model
			(model_name, version, model_type, model_file, active, create_time, update_time)
			VALUES (?,?,?,?,?,?,?)`, r.name, r.ver, r.mtype, r.file, r.active, ts, ts); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) seedConfigs(now time.Time) error {
	// 预警等级表
	var n int
	if err := s.DB.Get(&n, `SELECT COUNT(*) FROM alert_level_config`); err != nil {
		return err
	}
	if n == 0 {
		for _, l := range DefaultAlertLevels {
			if _, err := s.DB.Exec(`INSERT INTO alert_level_config
				(rank, name, level_key, color, water_level_threshold, duration_threshold, description, enabled)
				VALUES (?,?,?,?,?,?,?,?)`,
				l.Rank, l.Name, l.LevelKey, l.Color, l.WaterLevelThreshold, l.DurationThreshold, l.Description, l.Enabled); err != nil {
				return err
			}
		}
	}
	// 预见期配置：1h/3h 启用；6h/12h 预留
	if err := s.DB.Get(&n, `SELECT COUNT(*) FROM forecast_lead_config`); err != nil {
		return err
	}
	if n == 0 {
		leads := []LeadConfigRow{
			{1, true, 0.6, false}, {3, true, 0.4, false},
			{6, false, 0.3, true}, {12, false, 0.2, true},
		}
		for _, l := range leads {
			if _, err := s.DB.Exec(`INSERT INTO forecast_lead_config
				(lead_hours, enabled, default_weight, is_reserved) VALUES (?,?,?,?)`,
				l.LeadHours, l.Enabled, l.DefaultWeight, l.IsReserved); err != nil {
				return err
			}
		}
	}
	// 发布渠道（3 个）
	if err := s.DB.Get(&n, `SELECT COUNT(*) FROM publish_channel`); err != nil {
		return err
	}
	if n == 0 {
		channels := []PublishChannelRow{
			{Type: "inapp_msg", Name: "站内消息", Enabled: true,
				Endpoint: strPtr("app://notify"), Template: strPtr("【{levelName}】{stationName} {reason}")},
			{Type: "infoscreen", Name: "信息屏", Enabled: true,
				Endpoint: strPtr("screen://city-grid"), Template: strPtr("{stationName} {levelName}预警 {peakLevel}m")},
			{Type: "sms", Name: "短信", Enabled: false,
				Endpoint: strPtr("sms://ops-team"), Template: strPtr("【防汛】{stationName}{levelName}预警，峰值{peakLevel}m，{peakTime}")},
		}
		for _, c := range channels {
			if _, err := s.DB.Exec(`INSERT INTO publish_channel (type, name, enabled, endpoint, template)
				VALUES (?,?,?,?,?)`, c.Type, c.Name, c.Enabled, c.Endpoint, c.Template); err != nil {
				return err
			}
		}
	}
	// 数据源配置（四类多源）
	if err := s.DB.Get(&n, `SELECT COUNT(*) FROM datasource_config`); err != nil {
		return err
	}
	if n == 0 {
		schema := `[{"field":"ts","type":"datetime"},{"field":"level","type":"float"},{"field":"rain_observed","type":"float"}]`
		sources := []DatasourceConfigRow{
			{Type: "history_rain", Name: "历史降雨库", Status: "connected", Endpoint: strPtr("db://history/rain"),
				RefreshIntervalSec: 86400, SchemaJSON: strPtr(`[{"field":"ts","type":"datetime"},{"field":"rain","type":"float"}]`), Enabled: true},
			{Type: "history_waterlog", Name: "历史积水事件库", Status: "connected", Endpoint: strPtr("db://history/waterlog"),
				RefreshIntervalSec: 86400, SchemaJSON: strPtr(`[{"field":"ts","type":"datetime"},{"field":"level","type":"float"}]`), Enabled: true},
			{Type: "realtime_monitor", Name: "实时水位监测", Status: "connected", Endpoint: strPtr("sim://rolling"),
				RefreshIntervalSec: 300, SchemaJSON: strPtr(schema), Enabled: true},
			{Type: "weather_forecast", Name: "气象降雨预报", Status: "connected", Endpoint: strPtr("https://api.open-meteo.com/v1/forecast"),
				RefreshIntervalSec: 1800, SchemaJSON: strPtr(`[{"field":"ts","type":"datetime"},{"field":"precipitation","type":"float"}]`), Enabled: true},
		}
		for _, d := range sources {
			if _, err := s.DB.Exec(`INSERT INTO datasource_config
				(type, name, status, endpoint, refresh_interval_sec, schema_json, enabled, updated_at)
				VALUES (?,?,?,?,?,?,?,?)`,
				d.Type, d.Name, d.Status, d.Endpoint, d.RefreshIntervalSec, d.SchemaJSON, d.Enabled, now.Unix()); err != nil {
				return err
			}
		}
	}
	return nil
}

func strPtr(s string) *string { return &s }
