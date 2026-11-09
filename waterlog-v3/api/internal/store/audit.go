package store

import (
	"waterlog-v3/api/internal/domain"
)

// InsertAudit 落一条写操作留痕。
//
// 失败不返回错误给调用方（这里仍然返回，但中间件只记日志）：审计写不进去
// 不该让业务操作回滚——值班员按下"确认"时，宁可少一条日志，也不能让
// 预警卡在未确认状态。
func (s *Store) InsertAudit(e domain.AuditEntry) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		`INSERT INTO audit_log (at, username, role, method, path, status, duration_ms, ip, summary, request_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		e.At, e.Username, e.Role, e.Method, e.Path, e.Status, e.DurationMS, e.IP, e.Summary, e.RequestID)
	return err
}

// AuditEntries 按时间倒序返回审计记录。
//
// since 为 0 表示不限起点；username 为空表示不限账号。
func (s *Store) AuditEntries(since int64, username string, limit int) ([]domain.AuditEntry, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	s.mu.RLock()
	defer s.mu.RUnlock()

	q := `SELECT id, at, username, role, method, path, status, duration_ms, ip, summary, request_id
	        FROM audit_log WHERE at >= ?`
	args := []any{since}
	if username != "" {
		q += ` AND username = ?`
		args = append(args, username)
	}
	q += ` ORDER BY at DESC, id DESC LIMIT ?`
	args = append(args, limit)

	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []domain.AuditEntry{}
	for rows.Next() {
		var e domain.AuditEntry
		if err := rows.Scan(&e.ID, &e.At, &e.Username, &e.Role, &e.Method, &e.Path,
			&e.Status, &e.DurationMS, &e.IP, &e.Summary, &e.RequestID); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
