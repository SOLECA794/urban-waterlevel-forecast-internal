package service

import (
	"fmt"
	"math"
	"time"

	"waterlog/v2/internal/repo"
)

// ForecastService 预测占位实现：线性外推 + 启发式置信区间。
// EXT-POINT(MODEL): 真实模型（Prophet/LightGBM/TCN 等）实现 ForecastPoint 输出契约接入此处，
// 接口形态已固定：输入历史序列与预见期，输出逐点预测 + 置信上下界。
// 本期不考核精度（课程 demo 定位），故仅提供可运行的可视化占位。
type ForecastService struct {
	repo *repo.Repo
}

func NewForecastService(r *repo.Repo) *ForecastService { return &ForecastService{repo: r} }

// ForecastPoint 逐点预测结果。
type ForecastPoint struct {
	Ts    int64   `json:"ts"`
	Value float64 `json:"value"`
	Lower float64 `json:"lower"`
	Upper float64 `json:"upper"`
}

// ForecastResult 预测响应。
type ForecastResult struct {
	DeviceID   int64           `json:"deviceId"`
	Metric     string          `json:"metric"`
	ModelName  string          `json:"modelName"`
	ModelVer   string          `json:"modelVersion"`
	GeneratedAt int64          `json:"generatedAt"`
	HorizonMin int             `json:"horizonMin"`
	Points     []ForecastPoint `json:"points"`
	Note       string          `json:"note"`
}

// Run 执行预测：取最近 60 个点做最小二乘线性外推。
func (s *ForecastService) Run(deviceID int64, metric string, horizonMin, stepMin int) (*ForecastResult, error) {
	if metric == "" {
		metric = "water_level"
	}
	if horizonMin <= 0 {
		horizonMin = 60
	}
	if stepMin <= 0 {
		stepMin = 5
	}
	now := time.Now()
	from := now.Add(-3 * time.Hour).Unix()
	hist, err := s.repo.Series(deviceID, metric, from, now.Unix(), 60)
	if err != nil {
		return nil, err
	}
	if len(hist) < 5 {
		return &ForecastResult{
			DeviceID: deviceID, Metric: metric, ModelName: "InsufficientData", ModelVer: "v0",
			GeneratedAt: now.Unix(), HorizonMin: horizonMin, Points: []ForecastPoint{},
			Note: "历史样本不足 5 个点，无法外推（等待遥测积累）",
		}, nil
	}

	// 最小二乘：value = a + b*ts
	n := float64(len(hist))
	var sx, sy, sxx, sxy float64
	for _, h := range hist {
		x := float64(h.Ts)
		sx += x
		sy += h.Value
		sxx += x * x
		sxy += x * h.Value
	}
	den := n*sxx - sx*sx
	var b, a float64
	if math.Abs(den) < 1e-9 {
		b = 0
		a = sy / n
	} else {
		b = (n*sxy - sx*sy) / den
		a = (sy - b*sx) / n
	}
	// 残差标准差 → 置信带
	var ss float64
	for _, h := range hist {
		pred := a + b*float64(h.Ts)
		ss += (h.Value - pred) * (h.Value - pred)
	}
	sigma := math.Sqrt(ss / n)
	if sigma < 0.01 {
		sigma = 0.01
	}

	points := make([]ForecastPoint, 0, horizonMin/stepMin)
	start := now.Unix()
	histMin, histMax := hist[0].Value, hist[0].Value
	for _, h := range hist {
		if h.Value < histMin {
			histMin = h.Value
		}
		if h.Value > histMax {
			histMax = h.Value
		}
	}
	// 物理约束：预测落在「历史区间外扩」范围内，避免线性外推在陡升/陡降段发散出 0 或几十米
	lo := math.Max(0, histMin-0.5)
	hi := histMax + 1.5
	for m := stepMin; m <= horizonMin; m += stepMin {
		ts := start + int64(m*60)
		v := a + b*float64(ts)
		if v < lo {
			v = lo
		}
		if v > hi {
			v = hi
		}
		if v < 0 {
			v = 0
		}
		// 外推越长，不确定性越大（线性收敛增长：0.5σ·1.96 → 1.0σ·1.96）
		// 原 sqrt 增长在 60min 预见期可达 ±3.8m，会把坐标轴撑到 10m 以上，不符合水位量级直觉
		widen := 1.96 * sigma * (0.5 + 0.5*float64(m)/float64(horizonMin))
		lower := v - widen
		upper := v + widen
		// 置信带同样受物理区间约束，避免突破历史区间外扩边界
		if lower < lo {
			lower = lo
		}
		if upper > hi {
			upper = hi
		}
		points = append(points, ForecastPoint{Ts: ts, Value: round2(v), Lower: round2(lower), Upper: round2(upper)})
	}
	return &ForecastResult{
		DeviceID: deviceID, Metric: metric, ModelName: "LinearResponse", ModelVer: "v1.0",
		GeneratedAt: now.Unix(), HorizonMin: horizonMin, Points: points,
		Note: fmt.Sprintf("线性外推占位模型（样本 %d 点，σ=%.3f）；真实模型见 EXT-POINT(MODEL)", len(hist), sigma),
	}, nil
}
