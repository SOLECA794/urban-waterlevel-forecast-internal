// Package analysis LLM Provider（可选，带四级降级）。
package analysis

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// LLMConfig LLM 调用配置
type LLMConfig struct {
	Endpoint    string            `json:"endpoint" yaml:"endpoint"`
	APIKey      string            `json:"apiKey" yaml:"api_key"`
	Model       string            `json:"model" yaml:"model"`
	TimeoutSec  int               `json:"timeoutSec" yaml:"timeout_sec"`
	MaxTokens   int               `json:"maxTokens" yaml:"max_tokens"`
	Headers     map[string]string `json:"headers" yaml:"headers"`
	SystemPrompt string           `json:"systemPrompt" yaml:"system_prompt"`
}

// DefaultLLMConfig 返回默认配置（未启用状态）。
func DefaultLLMConfig() LLMConfig {
	return LLMConfig{
		Endpoint:     "",
		APIKey:       "",
		Model:        "",
		TimeoutSec:   15,
		MaxTokens:    1024,
		Headers:      map[string]string{},
		SystemPrompt: "你是一位城市内涝防汛研判专家。根据提供的监测点上下文，生成结构化的研判报告。必须按JSON格式输出，包含：situation（形势研判，100字以内）、risk_level（风险等级：低/中/高/极高）、suggestions（处置建议数组）、watch_points（关注要点数组）。",
	}
}

// LLMProvider 基于大语言模型的研判引擎
type LLMProvider struct {
	cfg    LLMConfig
	client *http.Client
}

// NewLLMProvider 构造 LLM 引擎。若 endpoint 为空则返回 nil（表示未启用）。
func NewLLMProvider(cfg LLMConfig) *LLMProvider {
	if strings.TrimSpace(cfg.Endpoint) == "" || strings.TrimSpace(cfg.APIKey) == "" {
		return nil
	}
	timeout := time.Duration(cfg.TimeoutSec) * time.Second
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	return &LLMProvider{
		cfg: cfg,
		client: &http.Client{
			Timeout: timeout,
		},
	}
}

// Name 返回引擎名。
func (p *LLMProvider) Name() string { return "llm" }

// Generate 调用 LLM 生成报告，带四级降级：
// 1. 请求超时 → fallback
// 2. HTTP 非 200 → fallback
// 3. 响应解析失败 → fallback
// 4. 结构不完整 → fallback（由 Service 层处理）
func (p *LLMProvider) Generate(ctx context.Context, rc ReportContext) (*ReportResult, error) {
	prompt := p.buildPrompt(rc)
	body, err := p.callLLM(ctx, prompt)
	if err != nil {
		return nil, fmt.Errorf("llm call failed: %w", err)
	}
	return p.parseResponse(body, rc)
}

func (p *LLMProvider) buildPrompt(rc ReportContext) string {
	return fmt.Sprintf(`监测点：%s（%s），位置：%s
当前水位：%.2fm
预警等级：%s
预测峰值：%.2fm（%s）
预见期：%d小时
过去6h降雨：%.1fmm
趋势：%s
选用模型：%s
降级模式：%v
请输出JSON格式研判报告。`,
		rc.StationCode, rc.StationName, rc.Location,
		rc.CurrentLevel, rc.AlertLevel,
		rc.ForecastPeak, rc.ForecastTime, rc.LeadHours,
		rc.RainLast6h, rc.Trend,
		rc.ModelSelected, rc.Degraded)
}

type llmMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type llmRequest struct {
	Model       string       `json:"model"`
	Messages    []llmMessage `json:"messages"`
	MaxTokens   int          `json:"max_tokens,omitempty"`
	Temperature float64      `json:"temperature,omitempty"`
}

type llmResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func (p *LLMProvider) callLLM(ctx context.Context, prompt string) (string, error) {
	reqBody := llmRequest{
		Model:       p.cfg.Model,
		MaxTokens:   p.cfg.MaxTokens,
		Temperature: 0.3,
		Messages: []llmMessage{
			{Role: "system", Content: p.cfg.SystemPrompt},
			{Role: "user", Content: prompt},
		},
	}
	b, _ := json.Marshal(reqBody)

	req, err := http.NewRequestWithContext(ctx, "POST", p.cfg.Endpoint, bytes.NewReader(b))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.cfg.APIKey)
	for k, v := range p.cfg.Headers {
		req.Header.Set(k, v)
	}

	resp, err := p.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("llm http %d: %s", resp.StatusCode, string(body))
	}

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}

	var lr llmResponse
	if err := json.Unmarshal(respBody, &lr); err != nil {
		// 有些接口直接返回 content 字符串
		return string(respBody), nil
	}
	if lr.Error != nil && lr.Error.Message != "" {
		return "", fmt.Errorf("llm api error: %s", lr.Error.Message)
	}
	if len(lr.Choices) == 0 {
		return "", fmt.Errorf("llm empty choices")
	}
	return lr.Choices[0].Message.Content, nil
}

type rawReport struct {
	Situation   string   `json:"situation"`
	RiskLevel   string   `json:"risk_level"`
	Suggestions []string `json:"suggestions"`
	WatchPoints []string `json:"watch_points"`
}

func (p *LLMProvider) parseResponse(content string, rc ReportContext) (*ReportResult, error) {
	// 尝试提取 JSON 块
	content = strings.TrimSpace(content)
	if idx := strings.Index(content, "{"); idx > 0 {
		content = content[idx:]
	}
	if idx := strings.LastIndex(content, "}"); idx > 0 && idx < len(content)-1 {
		content = content[:idx+1]
	}

	var raw rawReport
	if err := json.Unmarshal([]byte(content), &raw); err != nil {
		return nil, fmt.Errorf("parse llm response: %w", err)
	}

	// 校验完整性（四级降级之第4级：结构不完整）
	if raw.Situation == "" || raw.RiskLevel == "" || len(raw.Suggestions) == 0 {
		return nil, fmt.Errorf("incomplete llm response structure")
	}

	risk := RiskLevel(raw.RiskLevel)
	switch risk {
	case RiskLow, RiskMedium, RiskHigh, RiskCritical:
	default:
		risk = RiskMedium
	}

	return &ReportResult{
		StationID:   rc.StationID,
		StationCode: rc.StationCode,
		Situation:   raw.Situation,
		RiskLevel:   risk,
		Suggestions: raw.Suggestions,
		WatchPoints: raw.WatchPoints,
		Confidence:  0.75,
		Provider:    p.Name(),
		GeneratedAt: time.Now(),
		RawContext:  &rc,
	}, nil
}
