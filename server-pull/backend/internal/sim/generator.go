// Package sim 滚动观测数据生成器（演示模式 DEMO_MODE=true 时的数据来源）。
// 移植自 app/infrastructure/datasource/rolling_generator.py：
//   - tick(now) 以相对时间对齐采样网格追加样本，永不耗尽；
//   - 水位递推与 LinearResponseModel 共用同一套 gain/kernel/response_k 参数；
//   - inject_event 注入暴雨：观测雨强按 storm_shape 落入后续 tick，
//     同步把雨真值写入 future_truth 表供「上帝视角」预报取数；
//   - catch_up() 自愈：清空内存态从最后样本补齐到当前时刻。
package sim

import (
	"encoding/json"
	"fmt"
	"math"
	"sync"
	"time"

	"waterlog/backend/internal/forecast"
	"waterlog/backend/internal/rng"
	"waterlog/backend/internal/store"
)

// IntensityPreset 强度档位（P1-7 演示钥匙档位表）。
type IntensityPreset struct {
	PeakMm          float64
	DurationMinutes int
	Label           string
}

// IntensityPresets 档位表。
var IntensityPresets = map[string]IntensityPreset{
	"light":   {PeakMm: 2.2, DurationMinutes: 90, Label: "小雨"},
	"moderate": {PeakMm: 5.0, DurationMinutes: 120, Label: "中雨"},
	"heavy":   {PeakMm: 8.0, DurationMinutes: 150, Label: "大雨"},
	"extreme": {PeakMm: 12.0, DurationMinutes: 120, Label: "极端暴雨"},
}

// StormShape 雨强时程曲线：快速起涨 → 峰值 → 指数退去。
func StormShape(steps int, peak float64, r *rng.RNG) []float64 {
	n := steps
	if n < 1 {
		n = 1
	}
	out := make([]float64, n)
	for i := 0; i < n; i++ {
		var t float64
		if n > 1 {
			t = float64(i) / float64(n-1)
		}
		rise := 1 - math.Exp(-t*8)
		fall := math.Exp(-math.Max(t-0.45, 0)*6)
		jitter := r.Uniform(0.85, 1.15)
		out[i] = round2(math.Max(0, rise*fall*peak*jitter))
	}
	return out
}

// FloorToStep 对齐到采样步长（相对时间基准）。
func FloorToStep(ts time.Time, stepMinutes int) time.Time {
	m := ts.Truncate(time.Minute)
	offset := (m.Minute() % stepMinutes) * int(time.Minute)
	return m.Add(-time.Duration(offset))
}

func round2(v float64) float64 { return forecast.RoundN(v, 2) }
func round4(v float64) float64 { return forecast.RoundN(v, 4) }

type stationState struct {
	lastTS     *time.Time
	level      float64
	rainWindow []float64 // 最近 kernelLen 步雨强（含当前步）
}

type event struct {
	ID        string
	StartTs   int64
	EndTs     int64
	Shape     []float64
	Intensity string
}

// Generator 滚动模拟器；线程安全。
type Generator struct {
	mu              sync.Mutex
	store           *store.Store
	gain            float64
	kernel          []float64
	step            int
	drizzleProb     float64
	maxTickSteps    int
	maxCatchUpSteps int
	state           map[int64]*stationState
	events          map[int64][]*event
	eventSeq        int
}

// NewGenerator 构造（params 与 LinearResponseModel 同参，ADR-3 口径一致）。
func NewGenerator(st *store.Store, params forecast.ModelParams, stepMinutes int) *Generator {
	g := &Generator{
		store:           st,
		gain:            params.Gain,
		kernel:          forecast.BuildKernel(params.KernelLen, params.KernelTau),
		step:            stepMinutes,
		drizzleProb:     0.06,
		maxTickSteps:    12,
		maxCatchUpSteps: 600,
		state:           map[int64]*stationState{},
		events:          map[int64][]*event{},
	}
	g.loadEvents()
	return g
}

func (g *Generator) loadEvents() {
	rows, err := g.store.ListInjectedEvents(200)
	if err != nil {
		return
	}
	for _, r := range rows {
		shape := []float64{}
		if r.ShapeJSON != nil {
			_ = json.Unmarshal([]byte(*r.ShapeJSON), &shape)
		}
		g.events[r.StationID] = append(g.events[r.StationID], &event{
			ID: r.EventID, StartTs: r.StartTs, EndTs: r.EndTs,
			Shape: shape, Intensity: r.Intensity,
		})
		if n := parseSeq(r.EventID); n > g.eventSeq {
			g.eventSeq = n
		}
	}
}

func parseSeq(id string) int {
	var n int
	if _, err := fmt.Sscanf(id, "RAIN-%d", &n); err != nil {
		return 0
	}
	return n
}

type stationInfo struct {
	ID        int64
	BaseLevel float64
	ResponseK float64
}

func (g *Generator) stations() []stationInfo {
	rows, err := g.store.ListStations(true)
	if err != nil {
		return nil
	}
	out := make([]stationInfo, 0, len(rows))
	for _, r := range rows {
		base, k := 1.0, 0.01
		if r.BaseLevel != nil {
			base = *r.BaseLevel
		}
		if r.ResponseK != nil {
			k = *r.ResponseK
		}
		out = append(out, stationInfo{ID: r.StationID, BaseLevel: base, ResponseK: k})
	}
	return out
}

func (g *Generator) seedState(stationID int64, baseLevel float64) *stationState {
	win := make([]float64, len(g.kernel))
	latest, err := g.store.LatestObservation(stationID)
	if err == nil && latest != nil {
		ts := time.Unix(latest.Ts, 0)
		grid := FloorToStep(ts, g.step)
		var lvl float64
		if latest.Level != nil {
			lvl = *latest.Level
		}
		last := ts
		if grid != ts {
			last = grid
		}
		return &stationState{lastTS: &last, level: lvl, rainWindow: win}
	}
	return &stationState{lastTS: nil, level: baseLevel, rainWindow: win}
}

// 基础毛毛雨（确定性随机：以时间戳+站点为种子）。
func (g *Generator) baseDrizzle(stationID int64, ts time.Time) float64 {
	r := rng.New(uint64((ts.Unix()*1000 + stationID) % (1 << 32)))
	if r.Random() < g.drizzleProb {
		return round2(r.Uniform(0.1, 0.6))
	}
	return 0.0
}

func (g *Generator) eventRain(stationID int64, ts time.Time) float64 {
	total := 0.0
	for _, ev := range g.events[stationID] {
		if ev.StartTs <= ts.Unix() && ts.Unix() <= ev.EndTs {
			idx := int((ts.Unix() - ev.StartTs) / int64(g.step*60))
			if idx >= 0 && idx < len(ev.Shape) {
				total += ev.Shape[idx]
			}
		}
	}
	return total
}

// advance 递推一步：Δlevel = gain·Σwᵢ·rain − k·(level−base) + N(0,0.0015)。
func (g *Generator) advance(st *stationState, station stationInfo, ts time.Time) (time.Time, float64, float64) {
	rain := round2(g.baseDrizzle(station.ID, ts) + g.eventRain(station.ID, ts))
	win := st.rainWindow
	copy(win, win[1:])
	win[len(win)-1] = rain
	dot := 0.0
	for i := range win {
		dot += g.kernel[i] * win[i]
	}
	lvl := st.level + g.gain*dot - station.ResponseK*(st.level-station.BaseLevel)
	r := rng.New(uint64((ts.Unix()*7919 + station.ID) % (1 << 32)))
	lvl += r.Normal(0, 0.0015)
	lvl = math.Max(lvl, 0.0)
	st.level = lvl
	t := ts
	st.lastTS = &t
	return ts, round4(lvl), rain
}

// Tick 推进一轮采样：为每个启用点位补齐 [last+step, floor(now/step)] 的样本。
func (g *Generator) Tick(now time.Time) int {
	target := FloorToStep(now, g.step)
	written := 0
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, station := range g.stations() {
		n, err := g.tickStation(station, target, g.maxTickSteps)
		if err != nil {
			delete(g.state, station.ID) // 自愈：下轮重新播种
			continue
		}
		written += n
	}
	return written
}

func (g *Generator) tickStation(station stationInfo, target time.Time, cap int) (int, error) {
	st := g.state[station.ID]
	if st == nil {
		st = g.seedState(station.ID, station.BaseLevel)
		g.state[station.ID] = st
	}
	if st.lastTS == nil {
		// 空库冷启动：回填整段历史窗口（72h 需求，受追赶上限约束 → 50h@5min），
		// 保证 D1 模型选择有足够历史而不退化为 naive。
		n := g.maxCatchUpSteps // 600 步
		if need := 72 * 60 / g.step; need < n {
			n = need
		}
		t := target.Add(-time.Duration(n) * time.Duration(g.step) * time.Minute)
		st.lastTS = &t
	}
	fromTS := st.lastTS.Add(time.Duration(g.step) * time.Minute)
	if fromTS.After(target) {
		return 0, nil
	}
	// 追赶上限：差距过大时只补最近 cap 步（时间戳仍取相对时间，保证新鲜）
	earliest := target.Add(-time.Duration(cap-1) * time.Duration(g.step) * time.Minute)
	if fromTS.Before(earliest) {
		fromTS = earliest
		t := fromTS.Add(-time.Duration(g.step) * time.Minute)
		st.lastTS = &t
		st.level = station.BaseLevel // 长缺口后从基流水位重新起推
	}
	rows := make([]store.ObservationRow, 0, 16)
	ts := fromTS
	for !ts.After(target) {
		_, lvl, rain := g.advance(st, station, ts)
		l, r := lvl, rain
		rows = append(rows, store.ObservationRow{
			StationID: station.ID, Ts: ts.Unix(), Level: &l, RainObserved: &r,
		})
		ts = ts.Add(time.Duration(g.step) * time.Minute)
	}
	if len(rows) == 0 {
		return 0, nil
	}
	if err := g.store.UpsertObservations(rows); err != nil {
		return 0, err
	}
	return len(rows), nil
}

// CatchUp 自愈：清空内存态后从最后样本补齐到当前时刻。
func (g *Generator) CatchUp(now time.Time) int {
	target := FloorToStep(now, g.step)
	written := 0
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, station := range g.stations() {
		delete(g.state, station.ID)
		if n, err := g.tickStation(station, target, g.maxCatchUpSteps); err == nil {
			written += n
		}
	}
	return written
}

// FreshnessAgeMinutes 全部启用点位中最旧样本的滞后分钟数（健康检查口径）。
func (g *Generator) FreshnessAgeMinutes(now time.Time) *float64 {
	var worst *float64
	for _, station := range g.stations() {
		latest, err := g.store.LatestObservation(station.ID)
		if err != nil || latest == nil {
			v := 9999.0
			return &v
		}
		age := now.Sub(time.Unix(latest.Ts, 0)).Minutes()
		if age < 0 {
			age = 0
		}
		if worst == nil || age > *worst {
			worst = &age
		}
	}
	return worst
}

// InjectEvent 注入一场暴雨：观测雨强进入后续 tick，同步写入未来真值供预报取数。
func (g *Generator) InjectEvent(stationID int64, intensity string, now time.Time) (*store.InjectedEventRow, error) {
	preset, ok := IntensityPresets[intensity]
	if !ok {
		return nil, fmt.Errorf("不支持的强度档位 %s，可选 [light moderate heavy extreme]", intensity)
	}
	start := FloorToStep(now, g.step).Add(time.Duration(g.step) * time.Minute)
	steps := preset.DurationMinutes / g.step
	if steps < 1 {
		steps = 1
	}
	end := start.Add(time.Duration(steps-1) * time.Duration(g.step) * time.Minute)
	seed := uint64((now.Unix()*131 + stationID) % (1 << 32))
	shape := StormShape(steps, preset.PeakMm, rng.New(seed))

	g.mu.Lock()
	g.eventSeq++
	eventID := fmt.Sprintf("RAIN-%04d", g.eventSeq)
	shapeJSON, _ := json.Marshal(shape)
	g.events[stationID] = append(g.events[stationID], &event{
		ID: eventID, StartTs: start.Unix(), EndTs: end.Unix(), Shape: shape, Intensity: intensity,
	})
	g.mu.Unlock()

	// 写未来真值（分钟对齐 key，与 simulated.GetRainForecast 查询口径一致）
	entries := map[int64]float64{}
	for i, v := range shape {
		ts := start.Add(time.Duration(i) * time.Duration(g.step) * time.Minute)
		entries[ts.Unix()/60*60] += v
	}
	if err := g.store.AddFutureTruth(stationID, entries); err != nil {
		return nil, err
	}
	row := &store.InjectedEventRow{
		EventID: eventID, StationID: stationID, Intensity: intensity,
		IntensityLabel: &preset.Label, PeakMmPerStep: &preset.PeakMm,
		DurationMinutes: &preset.DurationMinutes, StartTs: start.Unix(), EndTs: end.Unix(),
		ShapeJSON: ptrStr(string(shapeJSON)), InjectedAt: now.Unix(),
	}
	if err := g.store.SaveInjectedEvent(row); err != nil {
		return nil, err
	}
	return row, nil
}

// LastSampleInfo 最新一条样本（演示口径：取 id 最大站点）。
func (g *Generator) LastSampleInfo() *store.ObservationRow {
	sts := g.stations()
	if len(sts) == 0 {
		return nil
	}
	r, _ := g.store.LatestObservation(sts[len(sts)-1].ID)
	return r
}

func ptrStr(s string) *string { return &s }
