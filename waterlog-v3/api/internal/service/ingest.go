package service

import (
	"waterlog-v3/api/internal/domain"
)

// IngestTelemetry 写入一批遥测并广播"变化"。
//
// 遥测广播只发"变化"，前端据此局部更新，不用整页刷新。
func (s *Service) IngestTelemetry(batch domain.TelemetryBatch) (int, error) {
	if err := s.store.InsertTelemetry(batch.Rows); err != nil {
		return 0, err
	}
	if len(batch.Rows) > 0 {
		s.hub.Broadcast("telemetry", batch.Rows)
	}
	return len(batch.Rows), nil
}

// IngestForecast 保存一次预测快照、写决策日志、推进预警四态并广播。
//
// 返回值：站点数、各站点的预警动作（raise/updated/cleared）、决策日志写入错误。
// 决策日志写失败不该阻断主流程，所以错误单独返回给 handler 决定怎么回。
func (s *Service) IngestForecast(p domain.ForecastPayload) (int, map[string]string, error) {
	if err := s.store.SaveForecast(p); err != nil {
		return 0, nil, err
	}
	s.SetForecast(&p)

	decErr := s.store.InsertDecisions(p)

	// 同步预警事件四态，并把变更广播出去
	actions := map[string]string{}
	for sid, sf := range p.Sites {
		ev, action, err := s.store.SyncWarning(sf.Warning, p.IssuedAt)
		if err != nil {
			continue
		}
		if action != "none" && ev != nil {
			if meta, ok := s.siteMap[sid]; ok {
				ev.SiteName = meta.Name
			}
			actions[sid] = action
			s.hub.Broadcast("warning", map[string]any{"action": action, "event": ev})
			// 站内 SSE 已经广播；这里把「已升到该等级」的消息推给外部渠道。
			// 只在 raised/upgraded 时推，updated 每轮都推会变成骚扰。
			if s.notifier != nil {
				s.notifier.NotifyWarning(ev, action, p.IssuedAt)
			}
		}
	}

	s.hub.Broadcast("forecast", map[string]any{
		"issued_at": p.IssuedAt, "model_version": p.ModelVersion, "sites": len(p.Sites),
	})
	return len(p.Sites), actions, decErr
}
