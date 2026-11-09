package service

import (
	"fmt"
	"strings"

	"waterlog-v3/api/internal/domain"
)

// Error 是带"该回什么状态码"语义的业务错误。
// handler 据此映射 400/404/409/500，错误文案一律原样透出（前端按文案做提示）。
type Error struct {
	Kind ErrorKind
	Msg  string
}

// ErrorKind 描述错误该映射到哪一类 HTTP 状态。
type ErrorKind int

const (
	// KindBadRequest → 400
	KindBadRequest ErrorKind = iota
	// KindNotFound → 404
	KindNotFound
	// KindConflict → 409
	KindConflict
	// KindInternal → 500
	KindInternal
)

func (e *Error) Error() string { return e.Msg }

func badRequest(format string, a ...any) *Error {
	return &Error{Kind: KindBadRequest, Msg: fmt.Sprintf(format, a...)}
}

func notFound(format string, a ...any) *Error {
	return &Error{Kind: KindNotFound, Msg: fmt.Sprintf(format, a...)}
}

func conflict(err error) *Error {
	return &Error{Kind: KindConflict, Msg: err.Error()}
}

func internal(err error) *Error {
	return &Error{Kind: KindInternal, Msg: err.Error()}
}

// ---------------------------------------------------------------- 处置闭环编排

// Ack 确认一条预警（四态轴），并广播。
func (s *Service) Ack(id int64) (map[string]any, error) {
	next, err := s.store.AckWarning(id, s.store.NowTS())
	if err != nil {
		// 非法迁移（重复确认 / 已清除）→ 409，前端据此提示而不是静默
		return nil, conflict(err)
	}
	s.hub.Broadcast("warning", map[string]any{"action": "acked", "id": id, "state": next})
	return map[string]any{"ok": true, "state": next}, nil
}

// Assign 派单：写入 assignee、补一条处置记录、广播。
func (s *Service) Assign(id int64, assignee string) (map[string]any, error) {
	assignee = strings.TrimSpace(assignee)
	if assignee == "" {
		return nil, badRequest("assignee 不能为空")
	}
	now := s.store.NowTS()
	if err := s.store.AssignWarning(id, assignee, now); err != nil {
		return nil, conflict(err)
	}
	_ = s.store.AddNote(id, now, "值班员", "dispatch", "派单给 "+assignee)
	s.hub.Broadcast("warning", map[string]any{"action": "assigned", "id": id})
	return map[string]any{"ok": true, "assignee": assignee}, nil
}

// Advance 推进处置状态（处置轴），并补一条处置记录。
func (s *Service) Advance(id int64, to, note, author string) (map[string]any, error) {
	now := s.store.NowTS()
	from, err := s.store.SetDisposition(id, to, now)
	if err != nil {
		return nil, conflict(err)
	}
	author = strings.TrimSpace(author)
	if author == "" {
		author = "值班员"
	}
	text := fmt.Sprintf("处置状态：%s → %s", domain.DispositionLabel(from), domain.DispositionLabel(to))
	if n := strings.TrimSpace(note); n != "" {
		text += "；" + n
	}
	_ = s.store.AddNote(id, now, author, "status", text)
	s.hub.Broadcast("warning", map[string]any{"action": "disposition", "id": id, "disposition": to})
	return map[string]any{"ok": true, "disposition": to}, nil
}

// Note 追加一条处置备注。
func (s *Service) Note(id int64, text, author, kind string) (map[string]any, error) {
	if strings.TrimSpace(text) == "" {
		return nil, badRequest("备注不能为空")
	}
	author = strings.TrimSpace(author)
	if author == "" {
		author = "值班员"
	}
	if kind == "" {
		kind = "note"
	}
	if _, _, err := s.store.AlertExists(id); err != nil {
		return nil, notFound("%s", err.Error())
	}
	if err := s.store.AddNote(id, s.store.NowTS(), author, kind, strings.TrimSpace(text)); err != nil {
		return nil, internal(err)
	}
	s.hub.Broadcast("warning", map[string]any{"action": "noted", "id": id})
	return map[string]any{"ok": true}, nil
}
