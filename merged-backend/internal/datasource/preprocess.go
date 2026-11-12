// Package datasource 多源数据预处理与特征工程。
// 移植自 app/infrastructure/forecast/preprocessor.py（pandas resample/ffill/interpolate
// 语义用单层循环 + 滑窗手写实现，行为对齐）。
package datasource

import (
	"math"
	"sort"
	"time"

	"waterlog/backend/internal/forecast"
)

// PreprocessReport 预处理报告。
type PreprocessReport struct {
	RawRows        int   `json:"rawRows"`
	CleanedRows    int   `json:"cleanedRows"`
	FilledPoints   int   `json:"filledPoints"`
	ClippedOutliers int  `json:"clippedOutliers"`
	WindowsH       []int `json:"windowsH"`
}

// FeatureRow 预处理 + 特征工程后的行（多源统一数据集，对应【分析模式】1）。
type FeatureRow struct {
	Ts           time.Time
	Level        float64
	RainObserved float64
	// 特征列
	RainSum1h, RainSum3h, RainSum6h float64
	RainMax1h, RainMax3h, RainMax6h float64
	LevelDiff, LevelRate            float64 // diff 可为 NaN（首行）
}

// Preprocessor 预处理管线。
type Preprocessor struct {
	StepMinutes  int
	LevelMin     float64
	LevelMax     float64
	MaxFillSteps int
	WindowsH     []int
}

// NewPreprocessor 默认参数构造（step=5min，范围[-0.5,20]，填补≤3步，窗口1/3/6h）。
func NewPreprocessor(stepMinutes int) *Preprocessor {
	return &Preprocessor{
		StepMinutes:  stepMinutes,
		LevelMin:     -0.5,
		LevelMax:     20.0,
		MaxFillSteps: 3,
		WindowsH:     []int{1, 3, 6},
	}
}

// bucketFloor 对齐到采样网格（相对时间基准）。
func (p *Preprocessor) bucketFloor(ts time.Time) time.Time {
	m := ts.Truncate(time.Minute)
	offset := (m.Minute() % p.StepMinutes) * int(time.Minute)
	return m.Add(-time.Duration(offset))
}

// Process 输入原始样本（乱序/缺行均可），输出对齐+清洗+填补+特征后的统一数据集。
func (p *Preprocessor) Process(rows []forecast.Obs) ([]FeatureRow, PreprocessReport) {
	rep := PreprocessReport{WindowsH: p.WindowsH}
	if len(rows) == 0 {
		return nil, rep
	}
	rep.RawRows = len(rows)

	// ---- 1. 时序对齐：按网格桶聚合（resample step min → mean）----
	sorted := append([]forecast.Obs{}, rows...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Ts.Before(sorted[j].Ts) })
	type bucket struct {
		ts                    time.Time
		levelSum, rainSum     float64
		levelN, rainN         int
	}
	buckets := []*bucket{}
	idxOf := map[time.Time]int{}
	for _, o := range sorted {
		key := p.bucketFloor(o.Ts)
		i, ok := idxOf[key]
		if !ok {
			buckets = append(buckets, &bucket{ts: key})
			i = len(buckets) - 1
			idxOf[key] = i
		}
		b := buckets[i]
		if !math.IsNaN(o.Level) {
			b.levelSum += o.Level
			b.levelN++
		}
		if !math.IsNaN(o.RainObserved) {
			b.rainSum += o.RainObserved
			b.rainN++
		}
	}
	// 补齐区间内的空桶（pandas resample 生成完整网格）
	first, last := buckets[0].ts, buckets[len(buckets)-1].ts
	step := time.Duration(p.StepMinutes) * time.Minute
	gridStart := first
	merged := make([]*bucket, 0, len(buckets))
	byTs := map[time.Time]*bucket{}
	for _, b := range buckets {
		byTs[b.ts] = b
	}
	for ts := gridStart; !ts.After(last); ts = ts.Add(step) {
		if b, ok := byTs[ts]; ok {
			merged = append(merged, b)
		} else {
			merged = append(merged, &bucket{ts: ts})
		}
	}

	levels := make([]float64, len(merged))   // NaN=缺失
	rains := make([]float64, len(merged))
	for i, b := range merged {
		if b.levelN > 0 {
			levels[i] = b.levelSum / float64(b.levelN)
		} else {
			levels[i] = math.NaN()
		}
		if b.rainN > 0 {
			rains[i] = b.rainSum / float64(b.rainN)
		} else {
			rains[i] = math.NaN()
		}
	}

	// ---- 2. 数据清洗：水位物理范围裁剪（范围外 → NaN）----
	notnaBefore := 0
	for _, v := range levels {
		if !math.IsNaN(v) {
			notnaBefore++
		}
	}
	for i, v := range levels {
		if !math.IsNaN(v) && (v < p.LevelMin || v > p.LevelMax) {
			levels[i] = math.NaN()
		}
	}
	notnaAfter := 0
	for _, v := range levels {
		if !math.IsNaN(v) {
			notnaAfter++
		}
	}
	rep.ClippedOutliers += notnaBefore - notnaAfter

	// ---- 3. 缺失值填补：ffill(≤3) + 线性插值(≤3) ----
	countNaN := func(arr []float64) int {
		n := 0
		for _, v := range arr {
			if math.IsNaN(v) {
				n++
			}
		}
		return n
	}
	fillSeries := func(arr []float64) int {
		nMissing := countNaN(arr)
		// ffill(limit=3)：前值填充，连续最多 3 步
		last := math.NaN()
		run := 0
		for i := range arr {
			if math.IsNaN(arr[i]) {
				if !math.IsNaN(last) && run < p.MaxFillSteps {
					arr[i] = last
					run++
				}
			} else {
				last = arr[i]
				run = 0
			}
		}
		// interpolate(linear, limit=3)：相邻有效点间线性插值，连续缺口最多填 3 个
		for i := 0; i < len(arr); i++ {
			if !math.IsNaN(arr[i]) {
				continue
			}
			// 找到以 i 开头的连续 NaN 段
			j := i
			for j < len(arr) && math.IsNaN(arr[j]) {
				j++
			}
			// 段 [i, j)；首段（无左锚点）保持 NaN（pandas 默认 limit_direction=forward）
			if i > 0 && j < len(arr) {
				n := j - i
				if n > p.MaxFillSteps {
					n = p.MaxFillSteps
				}
				left, right := arr[i-1], arr[j]
				for k := 0; k < n; k++ {
					frac := float64(k+1) / float64(j-i)
					arr[i+k] = left + (right-left)*frac
				}
			}
			i = j
		}
		return nMissing - countNaN(arr)
	}
	rep.FilledPoints += fillSeries(levels)
	rep.FilledPoints += fillSeries(rains)

	// ---- 4. 特征工程：多窗口累计降雨 + 雨强峰值 + 水位差分/变化率 ----
	out := make([]FeatureRow, len(merged))
	for i, b := range merged {
		rain := 0.0
		if !math.IsNaN(rains[i]) {
			rain = rains[i]
		}
		fr := FeatureRow{Ts: b.ts, Level: levels[i], RainObserved: rain}
		for _, h := range p.WindowsH {
			winSteps := h * 60 / p.StepMinutes
			lo := i - winSteps + 1
			if lo < 0 {
				lo = 0
			}
			sum, mx := 0.0, math.Inf(-1)
			for k := lo; k <= i; k++ {
				rv := 0.0
				if !math.IsNaN(rains[k]) {
					rv = rains[k]
				}
				sum += rv
				if rv > mx {
					mx = rv
				}
			}
			switch h {
			case 1:
				fr.RainSum1h, fr.RainMax1h = sum, mx
			case 3:
				fr.RainSum3h, fr.RainMax3h = sum, mx
			case 6:
				fr.RainSum6h, fr.RainMax6h = sum, mx
			}
		}
		if i > 0 {
			fr.LevelDiff = levels[i] - levels[i-1]
			fr.LevelRate = fr.LevelDiff / float64(p.StepMinutes) * 60.0
		} else {
			fr.LevelDiff = math.NaN()
			fr.LevelRate = math.NaN()
		}
		out[i] = fr
	}
	rep.CleanedRows = len(out)
	return out, rep
}
