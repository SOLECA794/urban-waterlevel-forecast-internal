package store

import (
	"database/sql"
	"errors"

	"waterlog-v3/api/internal/domain"
)

// NotifyChannels 读取全部推送渠道配置。
//
// 表里没有的渠道不会凭空出现——内置渠道的初始行由 service.EnsureChannels 写入，
// 这样"支持哪些渠道"只在一处定义，不会出现 SQL 里藏着一条没人知道的渠道名。
func (s *Store) NotifyChannels() ([]domain.NotifyChannel, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rows, err := s.db.Query(
		`SELECT name, enabled, endpoint, secret, min_level, debounce_min, updated_at
		   FROM notify_channel ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []domain.NotifyChannel{}
	for rows.Next() {
		var (
			c       domain.NotifyChannel
			enabled int
		)
		if err := rows.Scan(&c.Name, &enabled, &c.Endpoint, &c.Secret, &c.MinLevel,
			&c.DebounceMin, &c.UpdatedAt); err != nil {
			return nil, err
		}
		c.Enabled = enabled != 0
		out = append(out, c)
	}
	return out, rows.Err()
}

// NotifyChannel 取单个渠道；不存在返回 sql.ErrNoRows。
func (s *Store) NotifyChannel(name string) (*domain.NotifyChannel, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var (
		c       domain.NotifyChannel
		enabled int
	)
	err := s.db.QueryRow(
		`SELECT name, enabled, endpoint, secret, min_level, debounce_min, updated_at
		   FROM notify_channel WHERE name = ?`, name).
		Scan(&c.Name, &enabled, &c.Endpoint, &c.Secret, &c.MinLevel, &c.DebounceMin, &c.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if err != nil {
		return nil, err
	}
	c.Enabled = enabled != 0
	return &c, nil
}

// UpsertNotifyChannel 写入渠道配置（存在则覆盖）。
func (s *Store) UpsertNotifyChannel(c domain.NotifyChannel) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		`INSERT INTO notify_channel (name, enabled, endpoint, secret, min_level, debounce_min, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(name) DO UPDATE SET
		   enabled = excluded.enabled, endpoint = excluded.endpoint, secret = excluded.secret,
		   min_level = excluded.min_level, debounce_min = excluded.debounce_min,
		   updated_at = excluded.updated_at`,
		c.Name, boolInt(c.Enabled), c.Endpoint, c.Secret, c.MinLevel, c.DebounceMin, c.UpdatedAt)
	return err
}

// InsertDelivery 落一条推送结果。
func (s *Store) InsertDelivery(d domain.Delivery) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		`INSERT INTO notify_delivery (at, channel, site_id, level, ok, detail) VALUES (?, ?, ?, ?, ?, ?)`,
		d.At, d.Channel, d.SiteID, d.Level, boolInt(d.OK), d.Detail)
	return err
}

// Deliveries 按时间倒序返回推送记录。
func (s *Store) Deliveries(limit int) ([]domain.Delivery, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	rows, err := s.db.Query(
		`SELECT id, at, channel, site_id, level, ok, detail FROM notify_delivery
		  ORDER BY at DESC, id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []domain.Delivery{}
	for rows.Next() {
		var (
			d  domain.Delivery
			ok int
		)
		if err := rows.Scan(&d.ID, &d.At, &d.Channel, &d.SiteID, &d.Level, &ok, &d.Detail); err != nil {
			return nil, err
		}
		d.OK = ok != 0
		out = append(out, d)
	}
	return out, rows.Err()
}
