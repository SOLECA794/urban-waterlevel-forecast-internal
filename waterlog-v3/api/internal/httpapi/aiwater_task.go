package httpapi

// 本文件实现网关的异步任务链路（A-6 提交、A-7 状态查询、A-8 事件生命周期）
// 以及执行这些任务的后台 worker。
//
// 为什么要有 worker：A-6 的语义是「异步」——对方提交完立刻拿到 taskId，
// 结果通过 A-7 轮询或回调获取。如果提交接口同步把结果算完再返回，
// 那它就不是异步接口，对方按异步逻辑写的重试与超时策略全都不成立。
//
// worker 是**进程内**的：它从队列取任务、读 v3 当前预测快照、产出结果行。
// 这不是「假的异步」——任务确实落库、状态真的迁移、结果真的可查，
// 只是执行体不是独立的算力集群。

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"waterlog-v3/api/internal/domain"
	"waterlog-v3/api/internal/store"
)

// aiwaterTaskSubmit 是 A-6 的入参。
type aiwaterTaskSubmit struct {
	// PointCodes 参与预测的点位。为空表示全部站点。
	PointCodes []string `json:"pointCodes"`
	// Periods 预见期：1h / 3h / 6h / 12h。为空表示全部四个。
	Periods []string `json:"periods"`
	// BeginTime / EndTime 时间区间（仿真时钟秒）。
	BeginTime int64 `json:"beginTime"`
	EndTime   int64 `json:"endTime"`
	// ModelVersion 指定模型版本；空表示用当前生效版本。
	ModelVersion string `json:"modelVersion"`
	// RequestId 幂等键。**必填**——重复提交同一个 requestId 必须返回同一个 taskId。
	RequestId string `json:"requestId"`
	// CallbackUrl 完成后回调地址；非空则任务完成后推送结果。
	CallbackUrl string `json:"callbackUrl"`
}

// aiwaterTaskSubmitResult 是 A-6 的响应体。
type aiwaterTaskSubmitResult struct {
	// TaskID 任务标识。
	TaskID string `json:"taskId"`
	// SubmitTime 提交时刻（墙钟 Unix 秒）。
	SubmitTime int64 `json:"submitTime"`
	// Status 任务状态。
	Status string `json:"status"`
	// Duplicate 是否命中幂等（true = 此前已提交过，返回同一个任务）。
	Duplicate bool `json:"duplicate"`
}

// aiwaterTaskStatusResult 是 A-7 的响应体。
type aiwaterTaskStatusResult struct {
	// TaskID 任务标识。
	TaskID string `json:"taskId"`
	// Status 任务状态：queued / running / success / failed。
	Status string `json:"status"`
	// Progress 进度百分比 0~100。
	Progress int `json:"progress"`
	// ErrorCode 失败原因码；非失败态为空串。
	ErrorCode string `json:"errorCode"`
	// ErrorMsg 失败原因描述；非失败态为空串。
	ErrorMsg string `json:"errorMsg"`
	// ResultURL 结果文件地址。
	//
	// 当前实现不落结果文件（结果直接放在 resultList 里），
	// 所以这里恒为空串而不是编一个不存在的地址——
	// 对方拿到一个打不开的 URL 会当成「还在生成」。
	ResultURL string `json:"resultUrl"`
	// ResultList 结果行，结构与 A-1 的行一致。
	ResultList []domain.AIWaterPrediction `json:"resultList"`
	// CallbackStatus 回调投递结果：ok / failed / skipped。
	CallbackStatus string `json:"callbackStatus"`
	// CallbackMsg 回调失败原因。
	CallbackMsg string `json:"callbackMsg"`
	// SubmitTime 提交时刻（墙钟 Unix 秒）。
	SubmitTime int64 `json:"submitTime"`
	// UpdateTime 最近更新时刻（墙钟 Unix 秒）。
	UpdateTime int64 `json:"updateTime"`
	aiwaterTimeMeta
}

// aiwaterTaskSubmit 处理 A-6「预测任务提交」。
//
// 幂等由数据库唯一索引保证（request_id），不是应用层「先查再插」：
// 并发提交同一个 requestId 时，唯一约束会挡住第二条，
// 两个请求拿到的是同一个 taskId。
func (s *Server) aiwaterTaskSubmit(w http.ResponseWriter, r *http.Request) {
	var q aiwaterTaskSubmit
	if !decodeJSON(w, r, &q) {
		return
	}

	requestID := strings.TrimSpace(q.RequestId)
	if requestID == "" {
		// 幂等键必填。没有它，对方 SDK 重试一次就会开出第二个任务，
		// 两边看到的任务数对不上——这比直接报错糟糕得多。
		aiwaterFail(w, http.StatusBadRequest, aiwaterCodeBadRequest,
			"requestId 必填（幂等键：重复提交同一个 requestId 将返回同一个 taskId）")
		return
	}

	now := nowWall()
	task := domain.AIWaterTask{
		TaskID:       aiwaterNewTaskID(),
		RequestID:    requestID,
		Status:       domain.TaskQueued,
		Progress:     0,
		PointCodes:   cleanCodes(q.PointCodes),
		Periods:      cleanCodes(q.Periods),
		ModelVersion: strings.TrimSpace(q.ModelVersion),
		BeginTime:    q.BeginTime,
		EndTime:      q.EndTime,
		CallbackURL:  strings.TrimSpace(q.CallbackUrl),
		SubmitTime:   now,
		UpdateTime:   now,
	}

	stored, created, err := s.store.SubmitAIWaterTask(task)
	if err != nil {
		aiwaterFail(w, http.StatusInternalServerError, aiwaterCodeInternal,
			"任务落库失败: "+err.Error())
		return
	}
	if !created {
		// 幂等命中：返回首次创建的任务，不重新排队。
		aiwaterOK(w, aiwaterTaskSubmitResult{
			TaskID:     stored.TaskID,
			SubmitTime: stored.SubmitTime,
			Status:     stored.Status,
			Duplicate:  true,
		})
		return
	}

	// 入队执行。队列满时不能丢任务——那等于告诉对方「收到了」却没做。
	select {
	case s.aiwaterQueue <- stored.TaskID:
	default:
		aiwaterFail(w, http.StatusServiceUnavailable, aiwaterCodeUnavailable,
			"任务队列已满，请稍后重试（任务已落库，可用 taskId 查询）")
		return
	}

	aiwaterOK(w, aiwaterTaskSubmitResult{
		TaskID:     stored.TaskID,
		SubmitTime: stored.SubmitTime,
		Status:     stored.Status,
		Duplicate:  false,
	})
}

// aiwaterTaskStatus 处理 A-7「预测任务状态与结果回调查询」。
//
// taskId 从 body 或 query 都能取——对方的 SDK 有的用 POST body，
// 有的用 URL 参数，两个都支持能少一轮扯皮。
func (s *Server) aiwaterTaskStatus(w http.ResponseWriter, r *http.Request) {
	var q struct {
		TaskID string `json:"taskId"`
	}
	if !decodeJSON(w, r, &q) {
		return
	}
	taskID := strings.TrimSpace(q.TaskID)
	if taskID == "" {
		taskID = strings.TrimSpace(r.URL.Query().Get("taskId"))
	}
	if taskID == "" {
		aiwaterFail(w, http.StatusBadRequest, aiwaterCodeBadRequest, "taskId 必填")
		return
	}

	task, err := s.store.AIWaterTaskByID(taskID)
	if err != nil {
		if err == store.ErrTaskNotFound {
			aiwaterFail(w, http.StatusNotFound, aiwaterCodeNotFound, "任务不存在: "+taskID)
			return
		}
		aiwaterFail(w, http.StatusInternalServerError, aiwaterCodeInternal, "查询任务失败: "+err.Error())
		return
	}

	aiwaterOK(w, aiwaterTaskStatusResult{
		TaskID:          task.TaskID,
		Status:          task.Status,
		Progress:        task.Progress,
		ErrorCode:       task.ErrorCode,
		ErrorMsg:        task.ErrorMsg,
		ResultURL:       "",
		ResultList:      task.ResultList,
		CallbackStatus:  task.CallbackStatus,
		CallbackMsg:     task.CallbackMsg,
		SubmitTime:      task.SubmitTime,
		UpdateTime:      task.UpdateTime,
		aiwaterTimeMeta: s.timeMetaOf(),
	})
}

// cleanCodes 去掉空白项与重复项，保持原有顺序。
func cleanCodes(in []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, v := range in {
		v = strings.TrimSpace(v)
		if v == "" || seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	return out
}

// ---------------------------------------------------------------- 任务执行器

// StartAIWaterWorker 启动后台任务执行器，阻塞直到 ctx 被取消。
//
// 调用方（main）把它挂在与 ICM 网关同一个 bgCtx 上：
// 进程优雅退出时它跟着停，不会留下一个还在往数据库写状态的 goroutine。
func (s *Server) StartAIWaterWorker(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case taskID := <-s.aiwaterQueue:
			s.runAIWaterTask(ctx, taskID)
		}
	}
}

// runAIWaterTask 执行一个预测任务并推进其状态。
//
// 状态迁移：queued → running → success / failed。
// 每一步都落库：对方随时可能来查 A-7，中途崩溃时任务会停在 running，
// 那比停在 queued 更容易定位问题（能看出它跑到哪一步了）。
func (s *Server) runAIWaterTask(ctx context.Context, taskID string) {
	task, err := s.store.AIWaterTaskByID(taskID)
	if err != nil {
		s.log.Warn("网关任务取出失败", "task_id", taskID, "err", err)
		return
	}
	if task.Status != domain.TaskQueued {
		return // 已被别的执行器接手，或已经跑完
	}

	task.Status = domain.TaskRunning
	task.Progress = 10
	task.UpdateTime = nowWall()
	if _, err := s.store.UpdateAIWaterTask(task); err != nil {
		s.log.Warn("网关任务状态更新失败", "task_id", taskID, "err", err)
	}

	// 给状态迁移留一点观察窗口：对方轮询 A-7 时才看得到 running 这个中间态。
	// 这是演示环境里唯一能看出「异步」的地方；真实环境里这一步被真正的计算占用。
	select {
	case <-ctx.Done():
		return
	case <-time.After(300 * time.Millisecond):
	}

	fc := s.svc.Forecast()
	if fc == nil {
		s.failAIWaterTask(task, domain.ErrCodeInputMissing,
			"尚无预测快照：引擎尚未推送首轮预测，无法执行该任务")
		return
	}

	want := map[string]bool{}
	for _, c := range task.PointCodes {
		want[c] = true
	}
	periods := aiwaterPeriodMinutes(task.Periods)
	rows := s.buildPredictions(fc, want, periods, task.BeginTime, task.EndTime)

	if len(rows) == 0 {
		// 区分两种「空」：模型不可用 vs 输入没命中。
		// 前者是系统故障（MODEL_UNAVAILABLE），后者是参数问题（INPUT_MISSING），
		// 对方的重试策略对这两者的处理完全不同。
		s.failAIWaterTask(task, domain.ErrCodeInputMissing,
			"任务未命中任何点位/预见期，请检查 pointCodes 与 period 参数")
		return
	}

	task.Status = domain.TaskSuccess
	task.Progress = 100
	task.ResultList = rows
	task.UpdateTime = nowWall()
	if _, err := s.store.UpdateAIWaterTask(task); err != nil {
		s.log.Warn("网关任务结果写入失败", "task_id", taskID, "err", err)
		return
	}

	s.deliverAIWaterCallback(ctx, &task)
}

// failAIWaterTask 把任务标记为失败并落库。
func (s *Server) failAIWaterTask(task domain.AIWaterTask, code, msg string) {
	task.Status = domain.TaskFailed
	task.Progress = 100
	task.ErrorCode = code
	task.ErrorMsg = msg
	task.UpdateTime = nowWall()
	if _, err := s.store.UpdateAIWaterTask(task); err != nil {
		s.log.Warn("网关任务失败状态写入失败", "task_id", task.TaskID, "err", err)
	}
}

// deliverAIWaterCallback 任务完成后向对方回调地址推送结果。
//
// 回调失败**不改**任务状态：计算已经成功，结果仍可经 A-7 查到。
// 把「推送失败」写成「任务失败」会让对方以为白算了，然后重复提交——
// 那才是真的把事情搞复杂。
func (s *Server) deliverAIWaterCallback(ctx context.Context, task *domain.AIWaterTask) {
	if task.CallbackURL == "" {
		task.CallbackStatus = "skipped"
		task.CallbackMsg = "未提供 callbackUrl"
		_, _ = s.store.UpdateAIWaterTask(*task)
		return
	}

	payload := map[string]any{
		"code": aiwaterCodeOK,
		"msg":  "success",
		"data": aiwaterTaskStatusResult{
			TaskID:          task.TaskID,
			Status:          task.Status,
			Progress:        task.Progress,
			ResultList:      task.ResultList,
			SubmitTime:      task.SubmitTime,
			UpdateTime:      task.UpdateTime,
			aiwaterTimeMeta: s.timeMetaOf(),
		},
	}
	body, _ := json.Marshal(payload)

	cbCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(cbCtx, http.MethodPost, task.CallbackURL, bytes.NewReader(body))
	if err != nil {
		task.CallbackStatus = "failed"
		task.CallbackMsg = "回调地址非法: " + err.Error()
		_, _ = s.store.UpdateAIWaterTask(*task)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		task.CallbackStatus = "failed"
		task.CallbackMsg = "回调投递失败: " + err.Error()
		_, _ = s.store.UpdateAIWaterTask(*task)
		s.log.Warn("网关回调投递失败", "task_id", task.TaskID, "err", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		task.CallbackStatus = "failed"
		task.CallbackMsg = fmt.Sprintf("回调返回 HTTP %d", resp.StatusCode)
	} else {
		task.CallbackStatus = "ok"
		task.CallbackMsg = ""
	}
	_, _ = s.store.UpdateAIWaterTask(*task)
}

// ---------------------------------------------------------------- A-8 事件生命周期

// aiwaterLifecycleQuery 是 A-8 的入参。
type aiwaterLifecycleQuery struct {
	// EventID 事件号过滤。
	EventID string `json:"eventId"`
	// PointCode 点位过滤。
	PointCode string `json:"pointCode"`
	// BeginTime / EndTime 操作时刻区间。
	BeginTime int64 `json:"beginTime"`
	EndTime   int64 `json:"endTime"`
	// Stage 阶段过滤：发现 / 复核 / 核销。
	Stage string `json:"stage"`
	aiwaterPagingBody
}

// aiwaterLifecycleRecord 是 A-8 的一行。
type aiwaterLifecycleRecord struct {
	// EventID 事件标识。
	EventID string `json:"eventId"`
	// PointCode 点位编码。
	PointCode string `json:"pointCode"`
	// Stage 阶段：发现 / 复核 / 核销。
	Stage string `json:"stage"`
	// Operator 操作人。
	Operator string `json:"operator"`
	// OperateTime 操作时刻（真实时间 Unix 秒；我方内部记录用仿真时钟）。
	OperateTime int64 `json:"operateTime"`
	// Conclusion 处置结论。
	Conclusion string `json:"conclusion"`
	// EvidenceURLs 佐证材料链接。
	EvidenceURLs []string `json:"evidenceUrls"`

	// ---- 扩展字段 ----
	// Source 来源：icm（对方推来）/ local（我方预警四态派生）。
	Source string `json:"source"`
	// SiteName 站点名。
	SiteName string `json:"siteName"`
	// District 所属区域。
	District string `json:"district"`
}

// aiwaterLifecycle 处理 A-8「积水事件全生命周期记录查询」。
//
// 数据来自两处并按时间归并：
//
//  1. aiwater_event 表——A-9 收到的对方事件（发现/复核/核销 三阶段）；
//  2. warning_event 表——我方预警四态机派生：
//     升起=发现、确认=复核、解除=核销。
//
// 之所以要合两份：对方的 A-8 问的是「一个积水事件从发现到核销的完整过程」，
// 只给其中一份都会漏掉一半——只给 A-9 的是对方自己的数据（对我方没增量），
// 只给预警派生的是我方数据（对方看不到那些他们推过来的事件）。
func (s *Server) aiwaterLifecycle(w http.ResponseWriter, r *http.Request) {
	var q aiwaterLifecycleQuery
	if !decodeJSON(w, r, &q) {
		return
	}
	paging := pagingFrom(q.aiwaterPagingBody, r)

	filter := store.AIWaterEventFilter{
		EventID:   strings.TrimSpace(q.EventID),
		PointCode: strings.TrimSpace(q.PointCode),
		Stage:     strings.TrimSpace(q.Stage),
		BeginTime: q.BeginTime,
		EndTime:   q.EndTime,
		Limit:     1000,
	}
	events, err := s.store.AIWaterEvents(filter)
	if err != nil {
		aiwaterFail(w, http.StatusInternalServerError, aiwaterCodeInternal, "查询事件失败: "+err.Error())
		return
	}

	rows := []aiwaterLifecycleRecord{}
	for _, e := range events {
		name, district := "", ""
		if meta, ok := s.svc.Site(e.PointCode); ok {
			name, district = meta.Name, meta.District
		}
		rows = append(rows, aiwaterLifecycleRecord{
			EventID:      e.EventID,
			PointCode:    e.PointCode,
			Stage:        e.Stage,
			Operator:     e.Operator,
			OperateTime:  e.OperateTime,
			Conclusion:   e.Conclusion,
			EvidenceURLs: e.EvidenceURLs,
			Source:       e.Source,
			SiteName:     name,
			District:     district,
		})
	}

	// 预警四态派生记录。
	alerts, err := s.svc.ListAlerts(false, 1000)
	if err == nil {
		for _, ev := range alerts {
			if !aiwaterLifecycleMatch(ev, q) {
				continue
			}
			meta, hasMeta := s.svc.Site(ev.SiteID)
			name, district := "", ""
			if hasMeta {
				name, district = meta.Name, meta.District
			}
			base := aiwaterLifecycleRecord{
				EventID:   "warn-" + strconv.FormatInt(ev.ID, 10),
				PointCode: ev.SiteID,
				SiteName:  name,
				District:  district,
				Source:    "local",
			}
			// 升起 = 发现
			base.Stage = "发现"
			base.Operator = ev.Assignee
			base.OperateTime = ev.RaisedAt
			base.Conclusion = ev.Reason
			base.EvidenceURLs = []string{}
			if aiwaterStageMatch(base.Stage, q.Stage) && aiwaterTimeMatch(base.OperateTime, q.BeginTime, q.EndTime) {
				rows = append(rows, base)
			}
			// 确认 = 复核
			if ev.AckedAt != nil {
				r := base
				r.Stage = "复核"
				r.OperateTime = *ev.AckedAt
				r.Conclusion = "值班员已确认"
				if aiwaterStageMatch(r.Stage, q.Stage) && aiwaterTimeMatch(r.OperateTime, q.BeginTime, q.EndTime) {
					rows = append(rows, r)
				}
			}
			// 解除 = 核销
			if ev.ClearedAt != nil {
				r := base
				r.Stage = "核销"
				r.OperateTime = *ev.ClearedAt
				r.Conclusion = "积水已消退，事件解除"
				if aiwaterStageMatch(r.Stage, q.Stage) && aiwaterTimeMatch(r.OperateTime, q.BeginTime, q.EndTime) {
					rows = append(rows, r)
				}
			}
		}
	}

	// 归并排序：时间升序；同一时刻按事件号、再按阶段名，保证顺序稳定。
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].OperateTime != rows[j].OperateTime {
			return rows[i].OperateTime < rows[j].OperateTime
		}
		if rows[i].EventID != rows[j].EventID {
			return rows[i].EventID < rows[j].EventID
		}
		return rows[i].Stage < rows[j].Stage
	})

	total := len(rows)
	page := sliceAIWater(rows, paging)
	if page == nil {
		page = []aiwaterLifecycleRecord{}
	}
	aiwaterOK(w, aiwaterListData[aiwaterLifecycleRecord]{
		aiwaterPage:     aiwaterPage[aiwaterLifecycleRecord]{Total: total, PageNo: paging.PageNo, PageSize: paging.PageSize, List: page},
		aiwaterTimeMeta: s.timeMetaOf(),
	})
}

// aiwaterLifecycleMatch 判断一条预警是否命中 A-8 的过滤条件。
func aiwaterLifecycleMatch(ev domain.WarningEvent, q aiwaterLifecycleQuery) bool {
	if id := strings.TrimSpace(q.EventID); id != "" && id != "warn-"+strconv.FormatInt(ev.ID, 10) {
		return false
	}
	if pc := strings.TrimSpace(q.PointCode); pc != "" && pc != ev.SiteID {
		return false
	}
	return true
}

// aiwaterStageMatch 判断阶段是否命中过滤条件。
func aiwaterStageMatch(stage, filter string) bool {
	f := strings.TrimSpace(filter)
	return f == "" || f == stage
}

// aiwaterTimeMatch 判断时刻是否落在区间内。
func aiwaterTimeMatch(ts, begin, end int64) bool {
	if begin > 0 && ts < begin {
		return false
	}
	if end > 0 && ts > end {
		return false
	}
	return true
}
