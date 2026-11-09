// Package domain 存放与外部世界（Python 引擎、前端）约定的数据契约，
// 以及不依赖存储/HTTP 的纯业务规则（预警四态、处置五态）。
package domain

// 与 Python 引擎的 JSON 契约。
// 这里把结构体显式定义出来，而不是用 map[string]any 糊过去：
// 契约一旦变了，Go 侧编译期就能发现，而不是等前端图表画歪了才反应过来。

type Factors struct {
	Peak     float64 `json:"peak"`
	Duration float64 `json:"duration"`
	Trend    float64 `json:"trend"`
	Score    float64 `json:"score"`
}

type Horizon struct {
	HorizonMin int     `json:"horizon_min"`
	Level      float64 `json:"level"`
	Lower      float64 `json:"lower"`
	Upper      float64 `json:"upper"`
	Delta      float64 `json:"delta"`
	DeltaRaw   float64 `json:"delta_raw"`
	Corrected  float64 `json:"corrected"`
	Gain       float64 `json:"gain"`
	Sigma      float64 `json:"sigma"`
	Model      string  `json:"model"`
	Reason     string  `json:"reason"`
}

type Warning struct {
	SiteID      string    `json:"site_id"`
	Level       string    `json:"level"`
	Score       float64   `json:"score"`
	PeakValue   float64   `json:"peak_value"`
	PeakLevel   string    `json:"peak_level"`
	PeakAtMin   *int      `json:"peak_at_min"`
	DurationMin int       `json:"duration_min"`
	SlopeMH     float64   `json:"slope_mh"`
	Reason      string    `json:"reason"`
	BlockedBy   *string   `json:"blocked_by"`
	Factors     Factors   `json:"factors"`
	Thresholds  []float64 `json:"thresholds"`
	HorizonMin  int       `json:"horizon_min"`
}

type Decision struct {
	ShouldForecast bool           `json:"should_forecast"`
	Model          string         `json:"model"`
	Gain           float64        `json:"gain"`
	Reason         string         `json:"reason"`
	Signals        map[string]any `json:"signals"`
}

type SiteForecast struct {
	SiteID   string      `json:"site_id"`
	NowLevel float64     `json:"now_level"`
	Horizons []Horizon   `json:"horizons"`
	Curve    [][]float64 `json:"curve"`
	Warning  Warning     `json:"warning"`
	Decision Decision    `json:"decision"`
}

type ForecastPayload struct {
	IssuedAt     int64                   `json:"issued_at"`
	ModelVersion string                  `json:"model_version"`
	StepMin      int                     `json:"step_min"`
	Sites        map[string]SiteForecast `json:"sites"`
}

type TelemetryRow struct {
	TS       int64   `json:"ts"`
	SiteID   string  `json:"site_id"`
	Level    float64 `json:"level"`
	Rain     float64 `json:"rain"`
	Quality  int     `json:"quality"`
	RainFc1h float64 `json:"rain_fc_1h"`
	RainFc3h float64 `json:"rain_fc_3h"`
}

type TelemetryBatch struct {
	Rows []TelemetryRow `json:"rows"`
}

// SeriesPoint 是曲线上的一个点：时间、水位、雨量。
type SeriesPoint struct {
	TS    int64   `json:"ts"`
	Level float64 `json:"level"`
	Rain  float64 `json:"rain"`
}

// OverviewSite 是给"一张图"用的合并视图：站点静态信息 + 最新实测 + 预警研判。
type OverviewSite struct {
	SiteID     string    `json:"site_id"`
	Name       string    `json:"name"`
	District   string    `json:"district"`
	Lon        float64   `json:"lon"`
	Lat        float64   `json:"lat"`
	BaseLevel  float64   `json:"base_level"`
	Thresholds []float64 `json:"thresholds"`
	Kind       string    `json:"kind"`
	Level      float64   `json:"level"`
	Depth      float64   `json:"depth"`
	Rain       float64   `json:"rain"`
	Quality    int       `json:"quality"`
	Trend1h    float64   `json:"trend_1h"`
	WarnLevel  string    `json:"warn_level"`
	WarnScore  float64   `json:"warn_score"`
	PeakValue  float64   `json:"peak_value"`
	PeakAtMin  *int      `json:"peak_at_min"`
	Duration   int       `json:"duration_min"`
	SlopeMH    float64   `json:"slope_mh"`
	Reason     string    `json:"reason"`
	Factors    Factors   `json:"factors"`
	PeakLevel  string    `json:"peak_level"`
	HorizonMin int       `json:"horizon_min"`
	Spark      []float64 `json:"spark"`
	UpdatedAt  int64     `json:"updated_at"`
}

// SiteMeta 是站点静态元数据。站点清单的唯一事实来源是 Python 的 config.py，
// Go 侧只在启动时拉一份缓存（拉不到就用内置副本）。
type SiteMeta struct {
	SiteID      string    `json:"site_id"`
	Name        string    `json:"name"`
	District    string    `json:"district"`
	Lon         float64   `json:"lon"`
	Lat         float64   `json:"lat"`
	BaseLevel   float64   `json:"base_level"`
	Thresholds  []float64 `json:"thresholds"`
	Kind        string    `json:"kind"`
	CatchmentHa float64   `json:"catchment_ha"`
	PondHa      float64   `json:"pond_ha"`
	Impervious  float64   `json:"impervious"`
	Drainage    float64   `json:"drainage_mm_h"`
}

// WarningEvent 是一条预警的完整生命周期记录。
type WarningEvent struct {
	ID          int64   `json:"id"`
	SiteID      string  `json:"site_id"`
	SiteName    string  `json:"site_name"`
	Level       string  `json:"level"`
	Score       float64 `json:"score"`
	PeakValue   float64 `json:"peak_value"`
	PeakAtMin   *int    `json:"peak_at_min"`
	DurationMin int     `json:"duration_min"`
	SlopeMH     float64 `json:"slope_mh"`
	Reason      string  `json:"reason"`
	State       string  `json:"state"`
	Disposition string  `json:"disposition"`
	Assignee    string  `json:"assignee"`
	NoteCount   int     `json:"note_count"`
	RaisedAt    int64   `json:"raised_at"`
	AckedAt     *int64  `json:"acked_at"`
	ClearedAt   *int64  `json:"cleared_at"`
	UpdatedAt   int64   `json:"updated_at"`
}

// AlertNote 是一条处置记录。
type AlertNote struct {
	ID      int64  `json:"id"`
	AlertID int64  `json:"alert_id"`
	At      int64  `json:"at"`
	Author  string `json:"author"`
	Kind    string `json:"kind"`
	Text    string `json:"text"`
}
