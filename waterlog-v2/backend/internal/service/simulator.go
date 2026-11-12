package service

import (
	"hash/fnv"
	"log"
	"math"
	"math/rand"
	"sync"
	"time"

	"waterlog/v2/internal/model"
	"waterlog/v2/internal/repo"
)

// Simulator 模拟数据源：按设备画像生成水位/雨量，走与真实设备相同的遥测管道。
// EXT-POINT(DATASOURCE): 接入真实数据源时实现同一 Ingest 入参形态即可
// （如 SL651/Modbus/MQTT 适配器 → 组装 model.Sample → TelemetryService.Ingest），
// 规则引擎、告警、前端均无需改动。
type Simulator struct {
	repo *repo.Repo
	tel  *TelemetryService
	interval time.Duration

	mu      sync.Mutex
	phases  map[int64]float64 // 每设备相位，避免同步起伏
	rainUntil int64           // 模拟降雨结束时刻（unix 秒）
	rainPower float64         // 降雨强度系数
}

func NewSimulator(r *repo.Repo, t *TelemetryService, intervalSec int) *Simulator {
	if intervalSec <= 0 {
		intervalSec = 5
	}
	return &Simulator{repo: r, tel: t, interval: time.Duration(intervalSec) * time.Second, phases: map[int64]float64{}}
}

// Start 启动模拟循环。
func (s *Simulator) Start(stop <-chan struct{}) {
	go func() {
		t := time.NewTicker(s.interval)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				s.tick()
			case <-stop:
				return
			}
		}
	}()
}

func (s *Simulator) tick() {
	devices, err := s.repo.ListDevices()
	if err != nil {
		log.Printf("[sim] 读取设备失败: %v", err)
		return
	}
	now := time.Now().Unix()

	s.mu.Lock()
	// 5% 概率触发一次 3 分钟降雨（演示用，保证告警链路在演示时可复现）
	if now > s.rainUntil && rand.Float64() < 0.05 {
		s.rainUntil = now + 180
		s.rainPower = 0.6 + rand.Float64()*0.8
	}
	raining := now <= s.rainUntil
	rainPower := s.rainPower
	s.mu.Unlock()

	samples := make([]model.Sample, 0, len(devices))
	for _, d := range devices {
		if !d.Enabled {
			continue
		}
		prof, err := s.repo.GetProfile(d.ProfileID)
		if err != nil {
			continue
		}
		s.mu.Lock()
		ph, ok := s.phases[d.ID]
		if !ok {
			h := fnv.New32a()
			_, _ = h.Write([]byte(d.Code))
			ph = float64(h.Sum32()%628) / 100 // 0..6.28 相位
			s.phases[d.ID] = ph
		}
		s.mu.Unlock()

		vals := map[string]float64{}
		for _, key := range prof.Keys {
			switch key {
			case "water_level":
				// 基线全部压在蓝色阈值(1.3m)以下，常态无告警；仅降雨抬升后才越线。
				// 若基线高于阈值，蓝色告警会成为常驻噪声且永不自动清除（已踩坑）。
				base := 0.95 + float64(d.ID%5)*0.06
				wave := 0.12 * math.Sin(float64(now)/300+ph)
				noise := (rand.Float64() - 0.5) * 0.04
				surge := 0.0
				if raining {
					surge = rainPower * (0.5 + 0.5*math.Sin(float64(now)/60))
				}
				vals[key] = round2(base + wave + noise + surge)
			case "rainfall":
				v := 0.0
				if raining {
					v = round2(rainPower * (2 + rand.Float64()*4))
				}
				vals[key] = v
			case "flow":
				vals[key] = round2(2.5 + rand.Float64()*1.5)
			default:
				vals[key] = round2(rand.Float64() * 10)
			}
		}
		samples = append(samples, model.Sample{DeviceCode: d.Code, Ts: now, Values: vals})
	}
	if len(samples) > 0 {
		s.tel.Ingest(samples, "simulator")
	}
}

// InjectRain 演示入口：手动注入降雨；power=0 表示立即结束降雨。
func (s *Simulator) InjectRain(power float64, durationSec int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if power == 0 {
		s.rainUntil = 0
		return
	}
	if durationSec <= 0 {
		durationSec = 180
	}
	s.rainPower = power
	s.rainUntil = time.Now().Unix() + durationSec
}

// RainState 当前模拟降雨状态。
func (s *Simulator) RainState() (bool, float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return time.Now().Unix() <= s.rainUntil, s.rainPower
}

func round2(v float64) float64 { return math.Round(v*100) / 100 }
