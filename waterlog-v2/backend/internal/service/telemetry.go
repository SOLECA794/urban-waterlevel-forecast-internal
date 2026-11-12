package service

import (
	"database/sql"
	"fmt"
	"log"
	"sync"
	"time"

	"waterlog/v2/internal/model"
	"waterlog/v2/internal/repo"
)

// TelemetryService 遥测管道：校验 → 批量入库 → 设备心跳 → 规则求值 → 事件推送。
// 模拟数据与真实设备走同一条链路，保证链路与生产形态一致。
type TelemetryService struct {
	repo *repo.Repo
	hub  *Hub
	rule *RuleEngine

	// 设备编码缓存：避免每条遥测都查库
	mu       sync.RWMutex
	deviceByCode map[string]*model.Device
}

func NewTelemetryService(r *repo.Repo, h *Hub) *TelemetryService {
	return &TelemetryService{repo: r, hub: h, deviceByCode: make(map[string]*model.Device)}
}

// AttachRuleEngine 装配规则引擎（构造顺序解耦：引擎依赖告警服务，遥测依赖引擎）。
func (s *TelemetryService) AttachRuleEngine(e *RuleEngine) { s.rule = e }

// IngestResult 上报结果。
type IngestResult struct {
	Accepted int      `json:"accepted"`
	Rejected []string `json:"rejected"`
}

// Ingest 批量接收遥测。单条失败不阻断整批。
func (s *TelemetryService) Ingest(samples []model.Sample, source string) IngestResult {
	res := IngestResult{}
	now := time.Now().Unix()
	rows := make([]model.Telemetry, 0, len(samples)*3)
	type pending struct {
		dev  *model.Device
		vals map[string]float64
		ts   int64
	}
	var items []pending

	for _, sm := range samples {
		dev, err := s.resolveDevice(sm.DeviceCode)
		if err != nil {
			res.Rejected = append(res.Rejected, fmt.Sprintf("%s: %v", sm.DeviceCode, err))
			continue
		}
		if !dev.Enabled {
			res.Rejected = append(res.Rejected, sm.DeviceCode+": 设备已停用")
			continue
		}
		ts := sm.Ts
		if ts == 0 {
			ts = now
		}
		quality := sm.Quality
		if quality == "" {
			quality = "good"
		}
		if len(sm.Values) == 0 {
			res.Rejected = append(res.Rejected, sm.DeviceCode+": values 为空")
			continue
		}
		for metric, v := range sm.Values {
			rows = append(rows, model.Telemetry{
				DeviceID: dev.ID, Metric: metric, Ts: ts, Value: v, Quality: quality,
			})
		}
		items = append(items, pending{dev: dev, vals: sm.Values, ts: ts})
		res.Accepted++
	}
	if len(rows) == 0 {
		return res
	}
	if err := s.repo.InsertTelemetry(rows); err != nil {
		log.Printf("[telemetry] 批量写入失败: %v", err)
		res.Rejected = append(res.Rejected, "db: "+err.Error())
		return res
	}
	// 设备心跳
	for _, it := range items {
		_ = s.repo.TouchDevice(it.dev.ID, it.ts)
	}
	// 事件推送（一批一条，避免前端风暴）
	s.hub.Publish("telemetry", map[string]any{
		"source": source,
		"count":  len(rows),
		"samples": func() []map[string]any {
			out := make([]map[string]any, 0, len(items))
			for _, it := range items {
				out = append(out, map[string]any{
					"deviceId": it.dev.ID, "deviceCode": it.dev.Code, "ts": it.ts, "values": it.vals,
				})
			}
			return out
		}(),
	})
	// 规则求值（同步执行：保证告警即时可见；数据量 demo 级可接受）
	if s.rule != nil {
		for _, it := range items {
			for metric, v := range it.vals {
				s.rule.Evaluate(it.dev, metric, v, it.ts)
			}
		}
	}
	return res
}

func (s *TelemetryService) resolveDevice(code string) (*model.Device, error) {
	s.mu.RLock()
	if d, ok := s.deviceByCode[code]; ok {
		s.mu.RUnlock()
		return d, nil
	}
	s.mu.RUnlock()
	d, err := s.repo.GetDeviceByCode(code)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("设备编码不存在")
		}
		return nil, err
	}
	s.mu.Lock()
	s.deviceByCode[code] = d
	s.mu.Unlock()
	return d, nil
}

// InvalidateDeviceCache 设备增删改后清理缓存。
func (s *TelemetryService) InvalidateDeviceCache() {
	s.mu.Lock()
	s.deviceByCode = make(map[string]*model.Device)
	s.mu.Unlock()
}
