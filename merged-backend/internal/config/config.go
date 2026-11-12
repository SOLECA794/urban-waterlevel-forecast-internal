// Package config 配置：默认值（对齐原 config/default.yaml）+ 可选 YAML 覆盖 + 环境变量覆盖。
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"

	"waterlog/backend/internal/analysis"
)

// LinearResponseConfig 与原 forecast.linear_response 段一致。
type LinearResponseConfig struct {
	Gain          float64 `yaml:"gain" json:"gain"`
	KernelLen     int     `yaml:"kernel_len" json:"kernelLen"`
	KernelTau     float64 `yaml:"kernel_tau" json:"kernelTau"`
	ResponseK     float64 `yaml:"response_k" json:"responseK"`
	Decay         float64 `yaml:"decay" json:"decay"`
	CIBase        float64 `yaml:"ci_base" json:"ciBase"`
	CISqrtFactor  float64 `yaml:"ci_sqrt_factor" json:"ciSqrtFactor"`
}

// ForecastConfig 预测配置。
type ForecastConfig struct {
	ModelType       string                `yaml:"model_type" json:"modelType"`
	LeadHours       []int                 `yaml:"lead_hours" json:"leadHours"`
	StepMinutes     int                   `yaml:"step_minutes" json:"stepMinutes"`
	MinHistoryHours int                   `yaml:"min_history_hours" json:"minHistoryHours"`
	ScheduleMinutes int                   `yaml:"schedule_minutes" json:"scheduleMinutes"`
	SmoothingAlpha  float64               `yaml:"smoothing_alpha" json:"smoothingAlpha"`
	LinearResponse  LinearResponseConfig  `yaml:"linear_response" json:"linearResponse"`
}

// RevisionConfig 多源协同修正配置。
type RevisionConfig struct {
	Enabled             bool    `yaml:"enabled" json:"enabled"`
	Alpha               float64 `yaml:"alpha" json:"alpha"`
	Rho                 float64 `yaml:"rho" json:"rho"`
	Beta                float64 `yaml:"beta" json:"beta"`
	InnovationThreshold float64 `yaml:"innovation_threshold" json:"innovationThreshold"`
	RainGain            float64 `yaml:"rain_gain" json:"rainGain"`
}

// AlertConfig 预警配置。
type AlertConfig struct {
	DedupMinutes      int                `yaml:"dedup_minutes" json:"dedupMinutes"`
	ResolveMinutes    int                `yaml:"resolve_minutes" json:"resolveMinutes"`
	DefaultThresholds map[string]float64 `yaml:"default_thresholds" json:"defaultThresholds"`
}

// DatasourceConfig 数据源配置。
type DatasourceConfig struct {
	Type               string  `yaml:"type" json:"type"`
	IntervalMinutes    int     `yaml:"interval_minutes" json:"intervalMinutes"`
	HistoryHours       int     `yaml:"history_hours" json:"historyHours"`
	StaleAfterMinutes  float64 `yaml:"stale_after_minutes" json:"staleAfterMinutes"`
}

// StorageConfig 存储配置。
type StorageConfig struct {
	DataDir    string `yaml:"data_dir" json:"dataDir"`
	SQLitePath string `yaml:"sqlite_path" json:"sqlitePath"`
}

// AppConfig 应用配置。
type AppConfig struct {
	Name                  string `yaml:"name" json:"name"`
	Host                  string `yaml:"host" json:"host"`
	Port                  int    `yaml:"port" json:"port"`
	AutoForecastOnStartup bool   `yaml:"auto_forecast_on_startup" json:"autoForecastOnStartup"`
}

// AnalysisConfig 智能研判助手配置。
type AnalysisConfig struct {
	LLM analysis.LLMConfig `yaml:"llm" json:"llm"`
}

// Settings 总配置。
type Settings struct {
	App        AppConfig         `yaml:"app" json:"app"`
	Datasource DatasourceConfig `yaml:"datasource" json:"datasource"`
	Forecast   ForecastConfig   `yaml:"forecast" json:"forecast"`
	Revision   RevisionConfig   `yaml:"revision" json:"revision"`
	Alert      AlertConfig      `yaml:"alert" json:"alert"`
	Storage    StorageConfig    `yaml:"storage" json:"storage"`
	Analysis   AnalysisConfig   `yaml:"analysis" json:"analysis"`
	// 运行时项（仅环境变量）
	DBPath           string   `yaml:"-" json:"-"`
	Addr             string   `yaml:"-" json:"-"`
	DemoMode         bool     `yaml:"-" json:"-"`
	OpenMeteoEnabled bool     `yaml:"-" json:"-"`
	CORSOrigins      []string `yaml:"-" json:"-"`
}

// Default 返回与原 config/default.yaml 等价的默认配置。
// 差异（按任务要求）：滚动预测周期 5min → 15min；预见期默认 [1,3]（6/12h 预留）。
func Default() *Settings {
	return &Settings{
		App: AppConfig{
			Name:                  "城市内涝（积水）水位预测预警系统",
			Host:                  "0.0.0.0",
			Port:                  8080,
			AutoForecastOnStartup: true,
		},
		Datasource: DatasourceConfig{
			Type:              "simulated",
			IntervalMinutes:   5,
			HistoryHours:      72,
			StaleAfterMinutes: 30,
		},
		Forecast: ForecastConfig{
			ModelType:       "linear_response",
			LeadHours:       []int{1, 3},
			StepMinutes:     5,
			MinHistoryHours: 6,
			ScheduleMinutes: 15, // 任务要求：15 分钟预测周期（原默认 5）
			SmoothingAlpha:  0.6,
			LinearResponse: LinearResponseConfig{
				Gain:         0.006,
				KernelLen:    12,
				KernelTau:    5.0,
				ResponseK:    0.010,
				Decay:        0.08,
				CIBase:       0.02,
				CISqrtFactor: 0.06,
			},
		},
		Revision: RevisionConfig{
			Enabled:             true,
			Alpha:               0.6,
			Rho:                 0.85,
			Beta:                0.02,
			InnovationThreshold: 0.05,
			RainGain:            0.004,
		},
		Alert: AlertConfig{
			DedupMinutes:   30,
			ResolveMinutes: 15,
			DefaultThresholds: map[string]float64{
				"blue": 1.8, "yellow": 2.2, "orange": 2.6, "red": 3.0,
			},
		},
		Storage: StorageConfig{DataDir: "data", SQLitePath: "data/app.db"},
		Analysis: AnalysisConfig{
			LLM: analysis.DefaultLLMConfig(),
		},
		DBPath:           "data/app.db",
		Addr:             ":8080",
		DemoMode:         true,
		OpenMeteoEnabled: true,
	}
}

// Load YAML 文件覆盖默认值，再用环境变量覆盖部署敏感项。
func Load(path string) (*Settings, error) {
	s := Default()
	if path != "" {
		b, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("读取配置文件失败: %w", err)
		}
		if err := yaml.Unmarshal(b, s); err != nil {
			return nil, fmt.Errorf("解析配置文件失败: %w", err)
		}
	}
	s.applyEnv()
	return s, nil
}

func (s *Settings) applyEnv() {
	if v := os.Getenv("ADDR"); v != "" {
		s.Addr = v
	}
	if v := os.Getenv("DB_PATH"); v != "" {
		s.DBPath = v
	}
	if v := os.Getenv("DEMO_MODE"); v != "" {
		s.DemoMode = v == "true" || v == "1"
	}
	if v := os.Getenv("OPENMETEO_ENABLED"); v != "" {
		s.OpenMeteoEnabled = v == "true" || v == "1"
	}
	if v := os.Getenv("FORECAST_SCHEDULE_MIN"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			s.Forecast.ScheduleMinutes = n
		}
	}
	if v := os.Getenv("CORS_ORIGINS"); v != "" {
		s.CORSOrigins = strings.Split(v, ",")
		for i := range s.CORSOrigins {
			s.CORSOrigins[i] = strings.TrimSpace(s.CORSOrigins[i])
		}
	}
	if v := os.Getenv("WL_DEMO_KEY"); v != "" {
		// 预留：模拟事件注入演示钥匙（与原 WL_DEMO_KEY 对齐）
		_ = v
	}
}
