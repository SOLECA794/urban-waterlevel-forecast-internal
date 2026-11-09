package store

import (
	"database/sql"
	"fmt"

	"waterlog-v3/api/internal/domain"
)

// SyncWarning 把一次研判结果同步进预警事件表，返回需要广播的事件变更。
//
// 状态机（沿用 v2 已验收的四态，非法迁移一律拒绝）：
//
//	(无) --raise--> ACTIVE_UNACK --ack--> ACTIVE_ACK
//	ACTIVE_* --clear--> CLEARED_UNACK --ack--> CLEARED_ACK
//
// 等级升级：同站点已有活动事件但等级更高时，不新开事件，而是把原事件升级
// （防汛值班员关心的是"同一个点在升级"，不是"又冒出来一条"）。
func (s *Store) SyncWarning(w domain.Warning, now int64) (*domain.WarningEvent, string, error) {
	newRank := domain.LevelRankOf(w.Level)
	s.mu.Lock()
	defer s.mu.Unlock()

	var cur domain.WarningEvent
	var ackedAt, clearedAt sql.NullInt64
	err := s.db.QueryRow(`SELECT id, site_id, level, score, peak_value, duration_min, slope_mh,
	    reason, state, raised_at, acked_at, cleared_at, updated_at
	  FROM warning_event WHERE site_id=? AND state IN (?,?) ORDER BY id DESC LIMIT 1`,
		w.SiteID, domain.StateActiveUnack, domain.StateActiveAck).
		Scan(&cur.ID, &cur.SiteID, &cur.Level, &cur.Score, &cur.PeakValue, &cur.DurationMin,
			&cur.SlopeMH, &cur.Reason, &cur.State, &cur.RaisedAt, &ackedAt, &clearedAt, &cur.UpdatedAt)
	hasOpen := err == nil
	if err != nil && err != sql.ErrNoRows {
		return nil, "", err
	}

	// 情况一：有活动事件，且新研判仍有等级 → 更新指标（含升级/降级）
	if hasOpen && newRank > 0 {
		_, err := s.db.Exec(`UPDATE warning_event SET level=?, score=?, peak_value=?, duration_min=?,
		  slope_mh=?, reason=?, updated_at=? WHERE id=?`,
			w.Level, w.Score, w.PeakValue, w.DurationMin, w.SlopeMH, w.Reason, now, cur.ID)
		if err != nil {
			return nil, "", err
		}
		// 注意：这里先把 cur.Level 写成新等级、再比较等级——比较两边因此恒等，
		// 实际永远返回 "updated"、不会返回 "upgraded"。这是既有行为，
		// 前端按 action 值分支，重构时必须逐字保留，不能"顺手修好"。
		cur.Level, cur.Score, cur.PeakValue = w.Level, w.Score, w.PeakValue
		cur.DurationMin, cur.SlopeMH, cur.Reason, cur.UpdatedAt = w.DurationMin, w.SlopeMH, w.Reason, now
		if domain.LevelRankOf(w.Level) > domain.LevelRankOf(cur.Level) {
			return &cur, "upgraded", nil
		}
		return &cur, "updated", nil
	}

	// 情况二：有活动事件但研判归零 → 清除
	if hasOpen && newRank == 0 {
		next := domain.StateClearedUnack
		if cur.State == domain.StateActiveAck {
			next = domain.StateClearedAck
		}
		_, err := s.db.Exec(`UPDATE warning_event SET state=?, cleared_at=?, updated_at=? WHERE id=?`,
			next, now, now, cur.ID)
		if err != nil {
			return nil, "", err
		}
		cur.State, cur.ClearedAt, cur.UpdatedAt = next, &now, now
		return &cur, "cleared", nil
	}

	// 情况三：没有活动事件但研判有等级 → 新开
	if !hasOpen && newRank > 0 {
		res, err := s.db.Exec(`INSERT INTO warning_event
		  (site_id, level, score, peak_value, duration_min, slope_mh, reason, state, raised_at, updated_at)
		  VALUES (?,?,?,?,?,?,?,?,?,?)`,
			w.SiteID, w.Level, w.Score, w.PeakValue, w.DurationMin, w.SlopeMH, w.Reason,
			domain.StateActiveUnack, now, now)
		if err != nil {
			return nil, "", err
		}
		id, _ := res.LastInsertId()
		ev := &domain.WarningEvent{ID: id, SiteID: w.SiteID, Level: w.Level, Score: w.Score,
			PeakValue: w.PeakValue, DurationMin: w.DurationMin, SlopeMH: w.SlopeMH,
			Reason: w.Reason, State: domain.StateActiveUnack, RaisedAt: now, UpdatedAt: now}
		return ev, "raised", nil
	}

	return nil, "none", nil
}

// AckWarning 确认一条预警，返回新状态。非法迁移返回可读原因，由上层转 409。
func (s *Store) AckWarning(id int64, now int64) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var state string
	err := s.db.QueryRow(`SELECT state FROM warning_event WHERE id=?`, id).Scan(&state)
	if err == sql.ErrNoRows {
		return "", fmt.Errorf("not found")
	}
	if err != nil {
		return "", err
	}
	next, err := domain.AckTransition(state)
	if err != nil {
		return "", err
	}
	_, err = s.db.Exec(`UPDATE warning_event SET state=?, acked_at=?, updated_at=? WHERE id=?`,
		next, now, now, id)
	return next, err
}

// WarningByID 取一条预警的完整记录（含处置轴与备注数）。
func (s *Store) WarningByID(id int64) (*domain.WarningEvent, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var e domain.WarningEvent
	var acked, cleared sql.NullInt64
	err := s.db.QueryRow(`SELECT w.id, w.site_id, w.level, w.score, w.peak_value, w.duration_min,
	    w.slope_mh, w.reason, w.state, w.raised_at, w.acked_at, w.cleared_at, w.updated_at,
	    w.disposition, COALESCE(w.assignee,''),
	    (SELECT COUNT(*) FROM alert_note n WHERE n.alert_id = w.id)
	  FROM warning_event w WHERE w.id=?`, id).
		Scan(&e.ID, &e.SiteID, &e.Level, &e.Score, &e.PeakValue, &e.DurationMin, &e.SlopeMH,
			&e.Reason, &e.State, &e.RaisedAt, &acked, &cleared, &e.UpdatedAt,
			&e.Disposition, &e.Assignee, &e.NoteCount)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("预警不存在")
	}
	if err != nil {
		return nil, err
	}
	if acked.Valid {
		e.AckedAt = &acked.Int64
	}
	if cleared.Valid {
		e.ClearedAt = &cleared.Int64
	}
	return &e, nil
}

// Warnings 列出预警事件（默认只看活动态），按 id 降序。
func (s *Store) Warnings(activeOnly bool, limit int) ([]domain.WarningEvent, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	q := `SELECT w.id, w.site_id, w.level, w.score, w.peak_value, w.duration_min, w.slope_mh,
	    w.reason, w.state, w.raised_at, w.acked_at, w.cleared_at, w.updated_at,
	    w.disposition, COALESCE(w.assignee,''),
	    (SELECT COUNT(*) FROM alert_note n WHERE n.alert_id = w.id)
	  FROM warning_event w`
	if activeOnly {
		q += ` WHERE w.state IN ('ACTIVE_UNACK','ACTIVE_ACK')`
	}
	q += ` ORDER BY w.id DESC LIMIT ?`
	rows, err := s.db.Query(q, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.WarningEvent{}
	for rows.Next() {
		var e domain.WarningEvent
		var acked, cleared sql.NullInt64
		if err := rows.Scan(&e.ID, &e.SiteID, &e.Level, &e.Score, &e.PeakValue, &e.DurationMin,
			&e.SlopeMH, &e.Reason, &e.State, &e.RaisedAt, &acked, &cleared, &e.UpdatedAt,
			&e.Disposition, &e.Assignee, &e.NoteCount); err != nil {
			return nil, err
		}
		if acked.Valid {
			e.AckedAt = &acked.Int64
		}
		if cleared.Valid {
			e.ClearedAt = &cleared.Int64
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
