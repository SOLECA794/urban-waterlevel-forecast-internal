// Package analysis 智能研判助手：可插拔报告生成引擎。
package analysis

import (
	"context"
	"time"
)

// RiskLevel 风险等级
type RiskLevel string

const (
	RiskLow      RiskLevel = "低"
	RiskMedium   RiskLevel = "中"
	RiskHigh     RiskLevel = "高"
	RiskCritical RiskLevel = "极高"
)

// ReportSection 报告章节
type ReportSection struct {
	Title   string `json:"title"`
	Content string `json:"content"`
}

// ReportResult 研判报告结果
type ReportResult struct {
	ReportID    int64         `json:"reportId"`
	StationID   int64         `json:"stationId"`
	StationCode string        `json:"stationCode"`
	AlertID     *int64        `json:"alertId,omitempty"`
	ForecastID  *int64        `json:"forecastId,omitempty"`
	Situation   string        `json:"situation"`    // 形势研判
	RiskLevel   RiskLevel     `json:"riskLevel"`    // 风险等级
	Suggestions []string      `json:"suggestions"`  // 处置建议
	WatchPoints []string      `json:"watchPoints"`  // 关注要点
	Confidence  float64       `json:"confidence"`   // 置信度 0-1
	Provider    string        `json:"provider"`     // 生成引擎标识
	GeneratedAt time.Time     `json:"generatedAt"`
	RawContext  *ReportContext `json:"-"`           // 原始上下文（不入JSON）
}

// ReportContext 生成报告所需的上下文
type ReportContext struct {
	StationID       int64    `json:"stationId"`
	StationCode     string   `json:"stationCode"`
	StationName     string   `json:"stationName"`
	Location        string   `json:"location"`
	CurrentLevel    float64  `json:"currentLevel"`
	ThresholdBlue   float64  `json:"thresholdBlue"`
	ThresholdYellow float64  `json:"thresholdYellow"`
	ThresholdOrange float64  `json:"thresholdOrange"`
	ThresholdRed    float64  `json:"thresholdRed"`
	ForecastID      int64    `json:"forecastId"`
	ForecastPeak    float64  `json:"forecastPeak"`
	ForecastTime    string   `json:"forecastTime"`
	LeadHours       int      `json:"leadHours"`
	RainLast6h      float64  `json:"rainLast6h"`
	Trend           string   `json:"trend"`         // 上升/平稳/下降
	AlertLevel      string   `json:"alertLevel"`    // 蓝/黄/橙/红
	ModelSelected   string   `json:"modelSelected"`
	Degraded        bool     `json:"degraded"`
}

// Provider 研判报告生成引擎接口
type Provider interface {
	// Name 返回引擎标识名
	Name() string
	// Generate 基于上下文生成研判报告
	Generate(ctx context.Context, rc ReportContext) (*ReportResult, error)
}

// Service 研判服务：持有 Provider 链，默认 TemplateProvider
type Service struct {
	primary   Provider   // 主引擎（默认 TemplateProvider）
	fallback  Provider   // 降级引擎（默认也是 TemplateProvider，可配为LLM）
	llm       Provider   // 可选 LLM 引擎
}

// NewService 构造研判服务。
// 若 llm 非 nil 且配置有效，则 primary=llm, fallback=template；否则 primary=template。
func NewService(template Provider, llm Provider) *Service {
	if llm != nil {
		return &Service{primary: llm, fallback: template, llm: llm}
	}
	return &Service{primary: template, fallback: template}
}

// Generate 生成研判报告，自动处理降级。
func (s *Service) Generate(ctx context.Context, rc ReportContext) (*ReportResult, error) {
	res, err := s.primary.Generate(ctx, rc)
	if err != nil && s.fallback != nil && s.fallback != s.primary {
		res, err = s.fallback.Generate(ctx, rc)
		if err == nil && res != nil {
			res.Provider = s.fallback.Name() + "(fallback)"
		}
	}
	return res, err
}

// EngineName 返回当前主引擎标识（用于启动日志与运行时可观测）。
func (s *Service) EngineName() string {
	if s.primary != nil {
		return s.primary.Name()
	}
	return "none"
}
