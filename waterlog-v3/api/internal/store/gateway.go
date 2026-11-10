package store

// 本文件是「AI 平台自研网关」的持久化访问层：任务台账 + 事件幂等表。
//
// 只做「存」与「取」，不掺业务判断。唯一的判断是幂等键的去重——
// 而它靠的是数据库唯一索引，不是应用层的「先查再插」，
// 后者在并发下必然有窗口（两个请求同时查不到，然后都插进去）。

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"waterlog-v3/api/internal/domain"
)

// ErrTaskNotFound 表示按 taskId / requestId 查不到任务。
//
// 单独定义而不是返回 sql.ErrNoRows：handler 需要区分
// 「没有这个任务」（404）与「数据库坏了」（500），不能都当成前者。
var ErrTaskNotFound = errors.New("任务不存在")

// ---------------------------------------------------------------- 预测任务台账

// SubmitAIWaterTask 提交一个预测任务，返回落库后的任务与「是否新建」。
//
// 幂等：同一个 request_id 重复提交不会开出第二个任务，
// 而是返回首次创建的那一个（created=false）。
// 唯一索引在 request_id 上，冲突时走 INSERT OR IGNORE 再回读。
//
// taskID 由调用方生成（对外要能自解释、跨进程唯一），
// 这里不做生成——store 层不该知道 taskId 的命名规则。
func (s *Store) SubmitAIWaterTask(t domain.AIWaterTask) (domain.AIWaterTask, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	pointCodes, _ := json.Marshal(t.PointCodes)
	periods, _ := json.Marshal(t.Periods)
	resultList, _ := json.Marshal(t.ResultList)

	res, err := s.db.Exec(`INSERT OR IGNORE INTO aiwater_task
	  (task_id, request_id, status, progress, error_code, error_msg,
	   point_codes, periods, model_version, begin_time, end_time,
	   result_list, callback_url, callback_status, callback_msg, submit_time, update_time)
	  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		t.TaskID, t.RequestID, t.Status, t.Progress, t.ErrorCode, t.ErrorMsg,
		string(pointCodes), string(periods), t.ModelVersion, t.BeginTime, t.EndTime,
		string(resultList), t.CallbackURL, t.CallbackStatus, t.CallbackMsg,
		t.SubmitTime, t.UpdateTime)
	if err != nil {
		return domain.AIWaterTask{}, false, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		// request_id 已存在：这是幂等命中，不是错误。
		old, err := s.aiwaterTaskBy("request_id", t.RequestID)
		if err != nil {
			return domain.AIWaterTask{}, false, err
		}
		return old, false, nil
	}
	return t, true, nil
}

// AIWaterTaskByID 按 taskId 取任务。查不到返回 ErrTaskNotFound。
func (s *Store) AIWaterTaskByID(taskID string) (domain.AIWaterTask, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.aiwaterTaskBy("task_id", taskID)
}

// AIWaterTasks 取最近的若干条任务，用于运维排查与 A-7 的兜底查询。
func (s *Store) AIWaterTasks(limit int) ([]domain.AIWaterTask, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.db.Query(`SELECT task_id, request_id, status, progress, error_code, error_msg,
	    point_codes, periods, model_version, begin_time, end_time,
	    result_list, callback_url, callback_status, callback_msg, submit_time, update_time
	  FROM aiwater_task ORDER BY submit_time DESC, rowid DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.AIWaterTask{}
	for rows.Next() {
		t, err := scanAIWaterTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// UpdateAIWaterTask 更新任务状态。返回受影响的行数（0 表示任务不存在）。
//
// 只更新可变字段（状态、进度、错误、结果、更新时间），
// 不动 task_id / request_id / submit_time —— 那是任务的身份与出生时间。
func (s *Store) UpdateAIWaterTask(t domain.AIWaterTask) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	resultList, _ := json.Marshal(t.ResultList)
	res, err := s.db.Exec(`UPDATE aiwater_task SET status=?, progress=?, error_code=?, error_msg=?,
	    result_list=?, callback_status=?, callback_msg=?, update_time=? WHERE task_id=?`,
		t.Status, t.Progress, t.ErrorCode, t.ErrorMsg, string(resultList),
		t.CallbackStatus, t.CallbackMsg, t.UpdateTime, t.TaskID)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// aiwaterTaskBy 按指定列取值。调用方必须已持有锁。
func (s *Store) aiwaterTaskBy(col, val string) (domain.AIWaterTask, error) {
	// col 只能取这两个字面量，不来自外部输入；仍然用白名单形式写死，
	// 免得以后有人顺手拼字符串进来。
	if col != "task_id" && col != "request_id" {
		return domain.AIWaterTask{}, fmt.Errorf("非法查询列 %q", col)
	}
	rows, err := s.db.Query(`SELECT task_id, request_id, status, progress, error_code, error_msg,
	    point_codes, periods, model_version, begin_time, end_time,
	    result_list, callback_url, callback_status, callback_msg, submit_time, update_time
	  FROM aiwater_task WHERE `+col+`=?`, val)
	if err != nil {
		return domain.AIWaterTask{}, err
	}
	defer rows.Close()
	if !rows.Next() {
		return domain.AIWaterTask{}, ErrTaskNotFound
	}
	return scanAIWaterTask(rows)
}

// scanAIWaterTask 从一行结果集读出任务。JSON 列解析失败时退回空值，
// 不让一条脏数据把整个列表接口打挂。
func scanAIWaterTask(rows *sql.Rows) (domain.AIWaterTask, error) {
	var t domain.AIWaterTask
	var pointCodes, periods, resultList string
	if err := rows.Scan(&t.TaskID, &t.RequestID, &t.Status, &t.Progress, &t.ErrorCode, &t.ErrorMsg,
		&pointCodes, &periods, &t.ModelVersion, &t.BeginTime, &t.EndTime,
		&resultList, &t.CallbackURL,
		&t.CallbackStatus, &t.CallbackMsg, &t.SubmitTime, &t.UpdateTime); err != nil {
		return domain.AIWaterTask{}, err
	}
	_ = json.Unmarshal([]byte(pointCodes), &t.PointCodes)
	_ = json.Unmarshal([]byte(periods), &t.Periods)
	_ = json.Unmarshal([]byte(resultList), &t.ResultList)
	if t.PointCodes == nil {
		t.PointCodes = []string{}
	}
	if t.Periods == nil {
		t.Periods = []string{}
	}
	if t.ResultList == nil {
		t.ResultList = []domain.AIWaterPrediction{}
	}
	return t, nil
}

// ---------------------------------------------------------------- 事件幂等表

// InsertAIWaterEvent 写入一条事件生命周期记录，返回「是否真的写进去了」。
//
// 返回 false 表示这条 (event_id, stage) 已经存在——幂等命中。
// 主键冲突走 INSERT OR IGNORE，由数据库保证只留一条。
//
// 幂等命中时**不更新**原记录：对方重推的应该是同一条事实，
// 覆盖会把「第一次收到的原始报文」抹掉，事后对账时说不清谁改的。
func (s *Store) InsertAIWaterEvent(e domain.AIWaterEvent) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	evidence, _ := json.Marshal(e.EvidenceURLs)
	res, err := s.db.Exec(`INSERT OR IGNORE INTO aiwater_event
	  (event_id, point_code, stage, operator, operate_time, conclusion,
	   evidence_urls, source, payload_hash, received_at, updated_at)
	  VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		e.EventID, e.PointCode, e.Stage, e.Operator, e.OperateTime, e.Conclusion,
		string(evidence), e.Source, e.PayloadHash, e.ReceivedAt, e.UpdatedAt)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// AIWaterEventFilter 是事件查询条件。零值 = 不过滤该维度。
type AIWaterEventFilter struct {
	// EventID 按事件号精确匹配。
	EventID string
	// PointCode 按点位匹配。
	PointCode string
	// Stage 按阶段匹配。
	Stage string
	// BeginTime / EndTime 按操作时刻区间过滤（Unix 秒，闭区间）。
	// EndTime <= 0 表示不限上界。
	BeginTime int64
	EndTime   int64
	// Limit 返回条数上限；<=0 用默认值。
	Limit int
}

// AIWaterEvents 按条件查事件生命周期记录，按操作时刻升序。
func (s *Store) AIWaterEvents(f AIWaterEventFilter) ([]domain.AIWaterEvent, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var where []string
	var args []any
	if f.EventID != "" {
		where = append(where, "event_id=?")
		args = append(args, f.EventID)
	}
	if f.PointCode != "" {
		where = append(where, "point_code=?")
		args = append(args, f.PointCode)
	}
	if f.Stage != "" {
		where = append(where, "stage=?")
		args = append(args, f.Stage)
	}
	if f.BeginTime > 0 {
		where = append(where, "operate_time>=?")
		args = append(args, f.BeginTime)
	}
	if f.EndTime > 0 {
		where = append(where, "operate_time<=?")
		args = append(args, f.EndTime)
	}
	q := `SELECT event_id, point_code, stage, operator, operate_time, conclusion,
	    evidence_urls, source, payload_hash, received_at, updated_at FROM aiwater_event`
	if len(where) > 0 {
		q += " WHERE " + strings.Join(where, " AND ")
	}
	limit := f.Limit
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	q += " ORDER BY operate_time ASC, rowid ASC LIMIT ?"
	args = append(args, limit)

	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.AIWaterEvent{}
	for rows.Next() {
		var e domain.AIWaterEvent
		var evidence string
		if err := rows.Scan(&e.EventID, &e.PointCode, &e.Stage, &e.Operator, &e.OperateTime,
			&e.Conclusion, &evidence, &e.Source, &e.PayloadHash, &e.ReceivedAt, &e.UpdatedAt); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(evidence), &e.EvidenceURLs)
		if e.EvidenceURLs == nil {
			e.EvidenceURLs = []string{}
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// CountAIWaterEvents 返回满足条件的总条数，用于 A-8 的分页 total。
func (s *Store) CountAIWaterEvents(f AIWaterEventFilter) (int, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var where []string
	var args []any
	if f.EventID != "" {
		where = append(where, "event_id=?")
		args = append(args, f.EventID)
	}
	if f.PointCode != "" {
		where = append(where, "point_code=?")
		args = append(args, f.PointCode)
	}
	if f.Stage != "" {
		where = append(where, "stage=?")
		args = append(args, f.Stage)
	}
	if f.BeginTime > 0 {
		where = append(where, "operate_time>=?")
		args = append(args, f.BeginTime)
	}
	if f.EndTime > 0 {
		where = append(where, "operate_time<=?")
		args = append(args, f.EndTime)
	}
	q := `SELECT COUNT(*) FROM aiwater_event`
	if len(where) > 0 {
		q += " WHERE " + strings.Join(where, " AND ")
	}
	var total int
	if err := s.db.QueryRow(q, args...).Scan(&total); err != nil {
		return 0, err
	}
	return total, nil
}
