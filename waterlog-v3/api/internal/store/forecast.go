package store

import (
	"database/sql"
	"encoding/json"

	"waterlog-v3/api/internal/domain"
)

// SaveForecast 把一次完整预测快照落库（同一 issued_at 覆盖写）。
func (s *Store) SaveForecast(p domain.ForecastPayload) error {
	b, err := json.Marshal(p)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err = s.db.Exec(`INSERT OR REPLACE INTO forecast_snapshot(issued_at, model_version, payload)
	  VALUES (?,?,?)`, p.IssuedAt, p.ModelVersion, string(b))
	return err
}

// LatestForecast 取最近一次预测快照；没有快照时返回 (nil, nil)。
func (s *Store) LatestForecast() (*domain.ForecastPayload, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var payload string
	err := s.db.QueryRow(`SELECT payload FROM forecast_snapshot ORDER BY issued_at DESC LIMIT 1`).Scan(&payload)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var p domain.ForecastPayload
	if err := json.Unmarshal([]byte(payload), &p); err != nil {
		return nil, err
	}
	return &p, nil
}

// ForecastAt 取某站点在 targetTS 附近（±tolSec）的预测点，用于"预测 vs 实际"对比。
func (s *Store) ForecastAt(siteID string, targetTS int64, tolSec int64) ([]domain.Horizon, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rows, err := s.db.Query(`SELECT payload FROM forecast_snapshot ORDER BY issued_at DESC LIMIT 40`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []domain.Horizon
	seen := map[int]bool{}
	for rows.Next() {
		var payload string
		if err := rows.Scan(&payload); err != nil {
			return nil, err
		}
		var p domain.ForecastPayload
		if err := json.Unmarshal([]byte(payload), &p); err != nil {
			continue
		}
		sf, ok := p.Sites[siteID]
		if !ok {
			continue
		}
		for _, h := range sf.Horizons {
			at := p.IssuedAt + int64(h.HorizonMin*60)
			diff := at - targetTS
			if diff < 0 {
				diff = -diff
			}
			if diff <= tolSec && !seen[h.HorizonMin] {
				seen[h.HorizonMin] = true
				out = append(out, h)
			}
		}
	}
	return out, nil
}
