package store

import (
	"database/sql"
	"fmt"

	"waterlog-v3/api/internal/domain"
)

// AlertExists 检查预警是否存在，返回当前处置状态与派单人。
// 备注写入前用它把"预警不存在"挡成 404，而不是写一条挂空的记录。
func (s *Store) AlertExists(id int64) (string, string, error) {
	var disp string
	var assignee sql.NullString
	err := s.db.QueryRow(`SELECT disposition, assignee FROM warning_event WHERE id=?`, id).Scan(&disp, &assignee)
	if err == sql.ErrNoRows {
		return "", "", fmt.Errorf("预警不存在")
	}
	if err != nil {
		return "", "", err
	}
	return disp, assignee.String, nil
}

// AddNote 追加一条处置记录（谁在什么时间因为什么做了什么）。
func (s *Store) AddNote(id int64, at int64, author, kind, text string) error {
	_, err := s.db.Exec(`INSERT INTO alert_note(alert_id, at, author, kind, text) VALUES (?,?,?,?,?)`,
		id, at, author, kind, text)
	return err
}

// AlertNotes 取一条预警的全部处置记录（按写入顺序）。
func (s *Store) AlertNotes(id int64) ([]domain.AlertNote, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rows, err := s.db.Query(`SELECT id, alert_id, at, author, kind, text FROM alert_note
	  WHERE alert_id=? ORDER BY id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.AlertNote{}
	for rows.Next() {
		var n domain.AlertNote
		if err := rows.Scan(&n.ID, &n.AlertID, &n.At, &n.Author, &n.Kind, &n.Text); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// AssignWarning 派单。预警不存在时返回可读原因，由 handler 转 409。
func (s *Store) AssignWarning(id int64, assignee string, now int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec(`UPDATE warning_event SET assignee=?, updated_at=? WHERE id=?`, assignee, now, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("预警不存在")
	}
	return nil
}

// SetDisposition 推进处置状态，返回原状态。非法迁移返回可读原因，由 handler 转 409。
func (s *Store) SetDisposition(id int64, to string, now int64) (string, error) {
	if !domain.ValidDisposition(to) {
		return "", fmt.Errorf("未知处置状态 %s", to)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var from string
	err := s.db.QueryRow(`SELECT disposition FROM warning_event WHERE id=?`, id).Scan(&from)
	if err == sql.ErrNoRows {
		return "", fmt.Errorf("预警不存在")
	}
	if err != nil {
		return "", err
	}
	if from == to {
		return "", fmt.Errorf("已经是「%s」，无需重复操作", domain.DispositionLabel(to))
	}
	if !domain.CanTransition(from, to) {
		return "", fmt.Errorf("不能从「%s」直接改为「%s」", domain.DispositionLabel(from), domain.DispositionLabel(to))
	}
	if _, err := s.db.Exec(`UPDATE warning_event SET disposition=?, updated_at=? WHERE id=?`, to, now, id); err != nil {
		return "", err
	}
	return from, nil
}
