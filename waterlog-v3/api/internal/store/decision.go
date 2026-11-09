package store

import (
	"encoding/json"

	"waterlog-v3/api/internal/domain"
)

// InsertDecisions 把一次预测里各站点的"是否预测"决策写入决策日志。
func (s *Store) InsertDecisions(p domain.ForecastPayload) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	stmt, err := tx.Prepare(`INSERT INTO decision(ts, site_id, should_forecast, model, gain, reason, signals)
	  VALUES (?,?,?,?,?,?,?)`)
	if err != nil {
		tx.Rollback()
		return err
	}
	defer stmt.Close()
	for sid, sf := range p.Sites {
		sig, _ := json.Marshal(sf.Decision.Signals)
		if _, err := stmt.Exec(p.IssuedAt, sid, boolInt(sf.Decision.ShouldForecast),
			sf.Decision.Model, sf.Decision.Gain, sf.Decision.Reason, string(sig)); err != nil {
			tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
