// Package httpapi HTTP 接口层：chi 路由 + 契约 v1 DTO（camelCase，对齐前端原型）。
package httpapi

import "time"

// AlertLevelDTO /alert-levels 契约（AlertLevelConfig）。
type AlertLevelDTO struct {
	Rank                *int    `json:"rank"`
	Name                string  `json:"name"`
	LevelKey            string  `json:"levelKey"`
	Color               string  `json:"color"`
	WaterLevelThreshold float64 `json:"waterLevelThreshold"`
	DurationThreshold   int     `json:"durationThreshold"`
	Description         *string `json:"description"`
	Enabled             bool    `json:"enabled"`
}

// LeadDTO /forecast/leads 契约（ForecastLeadConfig）。
type LeadDTO struct {
	Lead          int     `json:"lead"`
	Enabled       bool    `json:"enabled"`
	DefaultWeight float64 `json:"defaultWeight"`
	IsReserved    bool    `json:"isReserved"`
}

// ChannelDTO /publish-channels 契约（PublishChannelConfig）。
type ChannelDTO struct {
	ID       int64   `json:"id"`
	Type     string  `json:"type"`
	Name     string  `json:"name"`
	Enabled  bool    `json:"enabled"`
	Endpoint *string `json:"endpoint"`
	Template *string `json:"template"`
}

// StationDTO /stations 契约（MonitoringStation）。
type StationDTO struct {
	StationID            int64              `json:"stationId"`
	StationCode          string             `json:"stationCode"`
	StationName          string             `json:"stationName"`
	Location             *string            `json:"location"`
	Kind                 *string            `json:"kind"`
	Enabled              bool               `json:"enabled"`
	Longitude            *float64           `json:"longitude"`
	Latitude             *float64           `json:"latitude"`
	CurrentLevel         *float64           `json:"currentLevel"`
	CurrentTs            *string            `json:"currentTs"`
	Trend                string             `json:"trend"`
	DataAgeMin           *float64           `json:"dataAgeMin"`
	AlertLevel           *int               `json:"alertLevel"`
	AlertLevelName       *string            `json:"alertLevelName"`
	AlertLevelColor      *string            `json:"alertLevelColor"`
	AlertID              *int64             `json:"alertId"`
	AlertReason          *string            `json:"alertReason"`
	IsReference          bool               `json:"isReference"`
	LeadMinutesAdvantage *int               `json:"leadMinutesAdvantage"`
	Thresholds           map[string]float64 `json:"thresholds"`
	BaseLevel            *float64           `json:"baseLevel"`
	ResponseK            *float64           `json:"responseK"`
	AlertStats           *StationAlertStats `json:"alertStats,omitempty"`
}

// StationAlertStats 站点维度预警统计。
type StationAlertStats struct {
	Total      int            `json:"total"`
	ByLevel    map[string]int `json:"byLevel"`
	Reference  int            `json:"reference"`
	Active     int            `json:"active"`
}

// SeriesPointDTO /stations/{id}/series 点。
type SeriesPointDTO struct {
	Ts           string   `json:"ts"`
	Level        *float64 `json:"level"`
	RainObserved float64  `json:"rainObserved"`
}

// SeriesDTO 时序响应。
type SeriesDTO struct {
	StationID   int64              `json:"stationId"`
	StationCode string             `json:"stationCode"`
	StepMinutes int                `json:"stepMinutes"`
	Thresholds  map[string]float64 `json:"thresholds"`
	Points      []SeriesPointDTO   `json:"points"`
}

// ForecastPointDTO 预测逐点（契约字段 time/waterLevel/confidenceLow/High + 追溯扩展）。
type ForecastPointDTO struct {
	Time           string  `json:"time"`
	WaterLevel     float64 `json:"waterLevel"`
	ConfidenceLow  float64 `json:"confidenceLow"`
	ConfidenceHigh float64 `json:"confidenceHigh"`
	LevelRaw       float64 `json:"levelRaw"`
	Revision       float64 `json:"revision"`
}

// FusionWeightsDTO D2 融合权重。
type FusionWeightsDTO struct {
	Level float64 `json:"level"`
	Rain  float64 `json:"rain"`
	Fcst  float64 `json:"fcst"`
}

// DecisionDTO D1–D5 决策（预测详情）。
type DecisionDTO struct {
	SelectedModel  string           `json:"selectedModel"`
	FusionWeights  FusionWeightsDTO `json:"fusionWeights"`
	RevisionAlpha  float64          `json:"revisionAlpha"`
	CiScale        float64          `json:"ciScale"`
	Degraded       bool             `json:"degraded"`
	Reason         string           `json:"reason"`
}

// AlertBriefDTO 预测关联预警摘要。
type AlertBriefDTO struct {
	AlertID              int64   `json:"alertId"`
	Level                int     `json:"level"`
	LevelKey             string  `json:"levelKey"`
	Reason               *string `json:"reason"`
	IsReference          bool    `json:"isReference"`
	LeadMinutesAdvantage *int    `json:"leadMinutesAdvantage"`
	Status               string  `json:"status"`
}

// ForecastRevisionDTO 契约（ForecastRevision）+ 追溯扩展。
type ForecastRevisionDTO struct {
	ID                  string              `json:"id"`
	StationID           int64               `json:"stationId"`
	StationCode         string              `json:"stationCode"`
	Lead                int                 `json:"lead"`
	GeneratedAt         string              `json:"generatedAt"`
	ModelVersion        string              `json:"modelVersion"`
	Points              []ForecastPointDTO  `json:"points"`
	TriggeredAlertLevel *int                `json:"triggeredAlertLevel"`
	Remarks             *string             `json:"remarks"`
	ForecastID          int64               `json:"forecastId"`
	PredictTime         string              `json:"predictTime"`
	PeakLevel           float64             `json:"peakLevel"`
	PeakTime            string              `json:"peakTime"`
	ConfidenceInterval  ConfidenceInterval  `json:"confidenceInterval"`
	Degraded            bool                `json:"degraded"`
	Rmse                *float64            `json:"rmse"`
	Mae                 *float64            `json:"mae"`
	Decision            *DecisionDTO        `json:"decision,omitempty"`
	Alert               *AlertBriefDTO      `json:"alert,omitempty"`
}

// ConfidenceInterval 整体置信区间。
type ConfidenceInterval struct {
	Lower float64 `json:"lower"`
	Upper float64 `json:"upper"`
}

// ActualPointDTO 实际观测点（版本对比）。
type ActualPointDTO struct {
	Time  string   `json:"time"`
	Level *float64 `json:"level"`
}

// ComparisonMetricsDTO 对比指标。
type ComparisonMetricsDTO struct {
	Mae         float64 `json:"mae"`
	Rmse        float64 `json:"rmse"`
	HitRate     float64 `json:"hitRate"`
	SampleCount int     `json:"sampleCount"`
}

// ComparisonDTO /forecasts/{id}/comparison 契约（ForecastComparison）。
type ComparisonDTO struct {
	Forecast ForecastRevisionDTO  `json:"forecast"`
	Actual   []ActualPointDTO     `json:"actual"`
	Metrics  ComparisonMetricsDTO `json:"metrics"`
}

// PublishHistoryDTO 预警发布历史条目。
type PublishHistoryDTO struct {
	RecordID    string `json:"recordId"`
	Channel     string `json:"channel"`
	ChannelCode string `json:"channelCode"`
	Status      string `json:"status"`
	Detail      string `json:"detail"`
	PublishTime string `json:"publishTime"`
}

// AlertEventDTO /alerts 契约（AlertEvent；level 为 rank，等级名/色由等级表渲染）。
type AlertEventDTO struct {
	AlertID              int64                `json:"alertId"`
	StationID            int64                `json:"stationId"`
	StationCode          string               `json:"stationCode"`
	StationName          string               `json:"stationName"`
	ForecastID           *int64               `json:"forecastId"`
	Level                int                  `json:"level"`
	LevelKey             string               `json:"levelKey"`
	LevelName            string               `json:"levelName"`
	LevelColor           string               `json:"levelColor"`
	Reason               *string              `json:"reason"`
	Reasoning            []string             `json:"reasoning"`
	PublishHistory       []PublishHistoryDTO  `json:"publishHistory"`
	Lead                 *int                 `json:"lead"`
	IsReference          bool                 `json:"isReference"`
	PeakLevel            *float64             `json:"peakLevel"`
	PeakTime             *string              `json:"peakTime"`
	LeadHours            *int                 `json:"leadHours"`
	AlertTime            string               `json:"alertTime"`
	ResolveTime          *string              `json:"resolveTime"`
	Status               string               `json:"status"`
	DurationMin          *int                 `json:"durationMin"`
	Trend                *float64             `json:"trend"`
	FalseReportReason    *string              `json:"falseReportReason"`
}

// AlertStatsDTO /alerts/stats 契约。
type AlertStatsDTO struct {
	TodayTotal       int            `json:"todayTotal"`
	EffectiveTotal   int            `json:"effectiveTotal"`
	ReferenceTotal   int            `json:"referenceTotal"`
	ActiveTotal      int            `json:"activeTotal"`
	ByLevel          map[string]int `json:"byLevel"`
	MaxEffectiveLevel *string       `json:"maxEffectiveLevel"`
}

// PageDTO 分页响应。
type PageDTO struct {
	Items    any `json:"items"`
	Total    int `json:"total"`
	Page     int `json:"page"`
	PageSize int `json:"pageSize"`
}

// QualityDTO 数据源质量快照。
type QualityDTO struct {
	SuccessRate *float64 `json:"successRate"`
	MissingRate *float64 `json:"missingRate"`
	AvgLatency  *float64 `json:"avgLatency"`
}

// DatasourceDTO /datasources 契约（DataSourceConfig）。
type DatasourceDTO struct {
	ID                 int64        `json:"id"`
	Type               string       `json:"type"`
	Name               string       `json:"name"`
	Status             string       `json:"status"`
	Endpoint           *string      `json:"endpoint"`
	RefreshIntervalSec int          `json:"refreshIntervalSec"`
	Quality            QualityDTO   `json:"quality"`
	Schema             []any        `json:"schema"`
	Enabled            bool         `json:"enabled"`
	LastError          *string      `json:"lastError"`
}

// CalibrationDTO /calibrations 契约（CalibrationRecord）。
type CalibrationDTO struct {
	ID         int64   `json:"id"`
	Type       string  `json:"type"`
	Target     *string `json:"target"`
	Before     any     `json:"before"`
	After      any     `json:"after"`
	Preview    any     `json:"preview"`
	Status     string  `json:"status"`
	ExecutedBy *string `json:"executedBy"`
	Note       *string `json:"note"`
	CreatedAt  string  `json:"createdAt"`
}

// ModelDTO /models 契约（ModelItem）。
type ModelDTO struct {
	ModelID          int64   `json:"modelId"`
	ModelName        string  `json:"modelName"`
	Version          string  `json:"version"`
	ModelType        string  `json:"modelType"`
	Active           bool    `json:"active"`
	Rmse             *float64 `json:"rmse"`
	Mae              *float64 `json:"mae"`
	ModelFile        string  `json:"modelFile"`
	AlgorithmConfig  any     `json:"algorithmConfig"`
	Activatable      bool    `json:"activatable"`
}

// HealthDetailDTO /health/detail 契约。
type HealthDetailDTO struct {
	Status     string            `json:"status"`
	Time       string            `json:"time"`
	Datasource map[string]any    `json:"datasource"`
	Model      map[string]any    `json:"model"`
	Database   map[string]any    `json:"database"`
	Scheduler  map[string]any    `json:"scheduler"`
}

// SimEventDTO /sim/events 契约（SimEvent）。
type SimEventDTO struct {
	EventID         string   `json:"eventId"`
	StationID       int64    `json:"stationId"`
	Intensity       string   `json:"intensity"`
	IntensityLabel  *string  `json:"intensityLabel"`
	PeakMmPerStep   *float64 `json:"peakMmPerStep"`
	DurationMinutes *int     `json:"durationMinutes"`
	StartTs         string   `json:"startTs"`
	EndTs           string   `json:"endTs"`
	InjectedAt      string   `json:"injectedAt"`
}

func fmtTime(unix int64) string { return time.Unix(unix, 0).Format(time.RFC3339) }
