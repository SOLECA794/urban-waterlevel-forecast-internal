package store

import (
	"database/sql"

	"waterlog-v3/api/internal/domain"
)

// InsertTelemetry 批量写入遥测（同一 (ts, site_id) 覆盖写）。
func (s *Store) InsertTelemetry(rows []domain.TelemetryRow) error {
	if len(rows) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	stmt, err := tx.Prepare(`INSERT OR REPLACE INTO telemetry
	  (ts, site_id, level, rain, quality, rain_fc_1h, rain_fc_3h) VALUES (?,?,?,?,?,?,?)`)
	if err != nil {
		tx.Rollback()
		return err
	}
	defer stmt.Close()
	for _, r := range rows {
		if _, err := stmt.Exec(r.TS, r.SiteID, r.Level, r.Rain, r.Quality, r.RainFc1h, r.RainFc3h); err != nil {
			tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

// Series 取某站点自 since 起的遥测曲线（按时间升序）。
func (s *Store) Series(siteID string, since int64) ([]domain.SeriesPoint, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rows, err := s.db.Query(
		`SELECT ts, level, rain FROM telemetry WHERE site_id=? AND ts>=? ORDER BY ts ASC`, siteID, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.SeriesPoint{}
	for rows.Next() {
		var p domain.SeriesPoint
		if err := rows.Scan(&p.TS, &p.Level, &p.Rain); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// Latest 取每站点最新一条遥测。
func (s *Store) Latest() (map[string]domain.TelemetryRow, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rows, err := s.db.Query(`
	  SELECT t.ts, t.site_id, t.level, t.rain, t.quality, t.rain_fc_1h, t.rain_fc_3h
	  FROM telemetry t
	  JOIN (SELECT site_id, MAX(ts) AS mts FROM telemetry GROUP BY site_id) m
	    ON t.site_id = m.site_id AND t.ts = m.mts`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]domain.TelemetryRow{}
	for rows.Next() {
		var r domain.TelemetryRow
		if err := rows.Scan(&r.TS, &r.SiteID, &r.Level, &r.Rain, &r.Quality, &r.RainFc1h, &r.RainFc3h); err != nil {
			return nil, err
		}
		out[r.SiteID] = r
	}
	return out, rows.Err()
}

// Trend 返回最近 spanMin 分钟的水位变化（米）。
func (s *Store) Trend(siteID string, spanMin int, now int64) float64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	from := now - int64(spanMin*60)
	var l0, l1 sql.NullFloat64
	_ = s.db.QueryRow(`SELECT level FROM telemetry WHERE site_id=? AND ts>=? ORDER BY ts ASC LIMIT 1`,
		siteID, from).Scan(&l0)
	_ = s.db.QueryRow(`SELECT level FROM telemetry WHERE site_id=? ORDER BY ts DESC LIMIT 1`,
		siteID).Scan(&l1)
	if !l0.Valid || !l1.Valid {
		return 0
	}
	return l1.Float64 - l0.Float64
}
