// Package service 应用服务层：预测 / 预警 / 校准 / 发布。
package service

import (
	"math"
	"time"

	"waterlog/backend/internal/agent"
	"waterlog/backend/internal/config"
	"waterlog/backend/internal/forecast"
)

// RevisionService 多源协同修正服务。
// 移植自 app/application/revision_service.py：
// corrected(t) = predicted(t) + α·e·ρ^(Δt/step)，仅对 Δt > 0 生效；
// 置信区间同步展宽：width(t) = width_raw(t)·(1 + β·Δt)。
type RevisionService struct {
	cfg config.RevisionConfig
}

// NewRevisionService 构造。
func NewRevisionService(cfg config.RevisionConfig) *RevisionService {
	return &RevisionService{cfg: cfg}
}

// RevPoint 修正后的单点输出。
type RevPoint struct {
	T         time.Time
	Revision  float64
	Corrected float64
}

// Apply 对预测逐点做衰减修正。
// e = w_level·e_level + w_rain·e_rain + w_fcst·e_fcst + event_bonus（权重来自 Agent-A D2）。
func (s *RevisionService) Apply(raw []forecast.PointResult, d *agent.Decision, tNow time.Time,
	innovation, rainInnovationMM, fcstShiftMM, eventBonus float64, stepMinutes int) []RevPoint {
	w := d.FusionWeights
	if w == (agent.FusionWeights{}) {
		w = agent.FusionWeights{Level: 0.45, Rain: 0.35, Fcst: 0.2}
	}
	// 降雨类新息（mm）换算为水位（m）：乘以等效增益
	eLevel := innovation
	eRain := rainInnovationMM * s.cfg.RainGain
	eFcst := fcstShiftMM * s.cfg.RainGain
	e := w.Level*eLevel + w.Rain*eRain + w.Fcst*eFcst
	// 已发生事件修正（FR二.3）：近 24h 有生效预警的站点，历史已证模型对其低估
	e += eventBonus
	alpha := d.RevisionAlpha
	rho := s.cfg.Rho

	out := make([]RevPoint, len(raw))
	for i, p := range raw {
		dtMin := math.Max(0.0, p.T.Sub(tNow).Minutes())
		steps := dtMin / float64(stepMinutes)
		var revision float64
		if alpha != 0 && e != 0 {
			revision = alpha * e * math.Pow(rho, steps)
		}
		out[i] = RevPoint{
			T:         p.T,
			Revision:  forecast.RoundN(revision, 5),
			Corrected: forecast.RoundN(p.LevelRaw+revision, 4),
		}
	}
	return out
}

// WidenCI 置信区间随预见期展宽：width = width_raw·(1 + β·Δt)。
func (s *RevisionService) WidenCI(halfWidth float64, t, tNow time.Time) float64 {
	dtMin := math.Max(0.0, t.Sub(tNow).Minutes())
	return halfWidth * (1.0 + s.cfg.Beta*dtMin)
}
