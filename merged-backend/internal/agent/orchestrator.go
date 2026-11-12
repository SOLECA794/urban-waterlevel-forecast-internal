// Package agent Agent-A 预测编排智能体：规则驱动 D1–D5 决策。
// 移植自 app/application/orchestrator.py（RuleBasedOrchestrator，逐行对齐）。
package agent

import (
	"fmt"
	"math"
	"strings"

	"waterlog/backend/internal/config"
	"waterlog/backend/internal/forecast"
)

// SourceQuality 数据源质量画像（对应原 SourceQuality dataclass）。
type SourceQuality struct {
	Status           string   // STREAMING / STALE / ERROR / DISCONNECTED
	MissingRate      float64  // 近 3h 缺失率 [0,1]
	LastSampleAgeMin float64  // 最新样本滞后分钟
	RecentRMSE       *float64 // 近期预测 RMSE（nil = 无记录）
	RainBias         float64  // 降雨系统性偏差（原实现未赋值，恒 0）
}

// ForecastContext 决策上下文。
type ForecastContext struct {
	StationID       int64
	StationCode     string
	LeadHours       int
	HistoryRows     int
	MinRows         int
	Innovation      float64
	Quality         SourceQuality
	ActiveModelType string
}

// FusionWeights D2 多源融合权重（level=水位 / rain=实测雨 / fcst=降雨预报）。
type FusionWeights struct {
	Level float64 `json:"level"`
	Rain  float64 `json:"rain"`
	Fcst  float64 `json:"fcst"`
}

// Decision D1–D5 决策结果（全量落 forecast_decision 表）。
type Decision struct {
	SelectedModel  string
	FusionWeights  FusionWeights
	RevisionAlpha  float64
	CiScale        float64
	Degraded       bool
	Reason         string
}

// Orchestrator 规则编排器。
type Orchestrator struct {
	Revision config.RevisionConfig
}

// NewOrchestrator 构造。
func NewOrchestrator(rev config.RevisionConfig) *Orchestrator {
	return &Orchestrator{Revision: rev}
}

// Decide 执行 D1–D5 五项决策。
func (o *Orchestrator) Decide(ctx *ForecastContext) Decision {
	q := ctx.Quality
	var reasons []string
	degraded := false
	var selected string

	// --- D5 降级决策：数据源断流 → NaiveModel + 标注「数据延迟」 ---
	switch {
	case q.Status == "ERROR" || q.Status == "DISCONNECTED":
		degraded, selected = true, "naive"
		reasons = append(reasons, fmt.Sprintf("数据源状态 %s，降级为持久性模型并标注数据延迟", q.Status))
	case q.LastSampleAgeMin > 30:
		degraded, selected = true, "naive"
		reasons = append(reasons, fmt.Sprintf("最新样本已滞后 %.0f 分钟，降级为持久性模型", q.LastSampleAgeMin))
	case ctx.HistoryRows < ctx.MinRows:
		// --- D1 数据不足 → NaiveModel ---
		selected = "naive"
		reasons = append(reasons, fmt.Sprintf("历史数据 %d 行不足最小窗口 %d 行，选持久性模型",
			ctx.HistoryRows, ctx.MinRows))
	default:
		selected = "nonlinear" // 默认主力：非线性汇流（特征工程+参数自学习）
		reasons = append(reasons, fmt.Sprintf("历史数据充足（%d 行），选用非线性汇流模型（多窗口特征+自学习参数）",
			ctx.HistoryRows))
	}

	if ctx.LeadHours == 6 || ctx.LeadHours == 12 {
		reasons = append(reasons, fmt.Sprintf("%dh 预见期强制启用降雨预报序列输入（D1）", ctx.LeadHours))
	}

	// --- D2 多源融合权重：w ∝ 1/(1+质量惩罚)，归一化 ---
	levelPenalty := 3.0*q.MissingRate + math.Min(q.LastSampleAgeMin/60.0, 1.0)
	rainPenalty := math.Abs(q.RainBias)
	fcstPenalty := 0.25 * (float64(ctx.LeadHours) / 12.0) // 预见期越长预报越不可信
	wLevel := 1.0 / (1.0 + levelPenalty)
	wRain := 1.0 / (1.0 + rainPenalty)
	wFcst := 1.0 / (1.0 + fcstPenalty)
	total := wLevel + wRain + wFcst
	w := FusionWeights{
		Level: forecast.RoundN(wLevel/total, 3),
		Rain:  forecast.RoundN(wRain/total, 3),
		Fcst:  forecast.RoundN(wFcst/total, 3),
	}
	if q.MissingRate > 0.1 {
		reasons = append(reasons, fmt.Sprintf("水位数据缺失率 %.0f%%，水位源权重下调至 %v",
			q.MissingRate*100, w.Level))
	}

	// --- D3 修正策略：新息超阈值 → 强修正 α=0.6，否则温和修正 α=0.3 ---
	alpha := 0.0
	if o.Revision.Enabled && !degraded {
		if math.Abs(ctx.Innovation) > o.Revision.InnovationThreshold {
			alpha = o.Revision.Alpha
			reasons = append(reasons, fmt.Sprintf("新息 %+.3f m 超阈值，启用强修正 α=%.1f",
				ctx.Innovation, alpha))
		} else {
			alpha = o.Revision.Alpha * 0.5
			reasons = append(reasons, fmt.Sprintf("新息平稳（%+.3f m），温和修正 α=%.2f",
				ctx.Innovation, alpha))
		}
	} else if degraded {
		// 降级态保留弱修正（alpha*0.3），避免双曲线完全重叠——演示卖点不能丢
		if o.Revision.Enabled {
			alpha = o.Revision.Alpha * 0.3
		}
		reasons = append(reasons, fmt.Sprintf("降级状态，弱修正 α=%.2f（保留新息校正但降低强度）", alpha))
	} else {
		reasons = append(reasons, "协同修正已关闭（配置 revision.enabled=false）")
	}

	// --- D4 置信区间自适应：宽度 ∝ 近期RMSE × √h，数据质量差则加宽 ---
	ciScale := 1.0
	if q.RecentRMSE != nil && *q.RecentRMSE != 0 {
		ciScale *= math.Max(0.5, math.Min(3.0, *q.RecentRMSE/0.05))
	}
	if q.MissingRate > 0.05 {
		ciScale *= 1.0 + 2.0*q.MissingRate
	}
	if degraded {
		ciScale *= 1.5
	}
	ciScale = forecast.RoundN(ciScale, 3)

	return Decision{
		SelectedModel:  selected,
		FusionWeights:  w,
		RevisionAlpha:  forecast.RoundN(alpha, 3),
		CiScale:        ciScale,
		Degraded:       degraded,
		Reason:         strings.Join(reasons, "；"),
	}
}
