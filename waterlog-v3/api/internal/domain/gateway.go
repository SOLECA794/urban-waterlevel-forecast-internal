package domain

// 本文件是「AI 平台自研网关」（/api/aiwater/v1/*）的领域类型。
//
// 与 v3 原生领域模型的关系：
//
//   - v3 原生类型（TelemetryRow / WarningEvent / ForecastPayload…）服务的是
//     9 个前端页面，字段名是 snake_case，动不得；
//   - 这里的类型服务的是对外网关，字段名 camelCase、语义按对方口径重新表述
//     （预警四级 → 对外三级、仿真时间 → 双时钟标注）。
//
// 两者之间只做**单向映射**：网关读 v3 的类型、产出这里的类型。
// 反过来让 v3 的类型迁就对方口径，会把协议差异渗进主干——
// 那正是集成网关存在的意义（见 docs/06 §2.2）。

// AIWaterTask 状态机的四个取值。与设计文档 §4.3 的异步任务业务态一致。
const (
	// TaskQueued 已入队，等待执行。
	TaskQueued = "queued"
	// TaskRunning 执行中。
	TaskRunning = "running"
	// TaskSuccess 执行成功，结果在 ResultList。
	TaskSuccess = "success"
	// TaskFailed 执行失败，原因在 ErrorCode / ErrorMsg。
	TaskFailed = "failed"
)

// 异步任务的失败原因码（设计文档 §4.3）。
const (
	// ErrCodeInputMissing 输入数据缺失（对应条款 9-9）。
	ErrCodeInputMissing = "INPUT_MISSING"
	// ErrCodeModelUnavailable 模型不可用。
	ErrCodeModelUnavailable = "MODEL_UNAVAILABLE"
	// ErrCodeTimeout 执行超时。
	ErrCodeTimeout = "TIMEOUT"
	// ErrCodeQuotaExceeded 算力配额超限。
	ErrCodeQuotaExceeded = "QUOTA_EXCEEDED"
	// ErrCodeInternal 内部错误。
	ErrCodeInternal = "INTERNAL"
)

// AIWaterTask 是 A-6「预测任务提交」产生的一条任务台账。
//
// 为什么落库而不是只放内存：
//
//   - 对方的 requestId 幂等语义要求「重复提交返回同一 taskId」，这需要跨进程重启仍然成立；
//   - 条款 9-9 要求「预测运行管理」有台账、可查历史，内存里的记录重启就没了；
//   - 任务状态本身是业务事实，不是缓存。
type AIWaterTask struct {
	// TaskID 任务标识，对外唯一。
	TaskID string
	// RequestID 对方提交的幂等键。唯一索引保证重复提交不会开出第二个任务。
	RequestID string
	// Status 任务状态：queued / running / success / failed。
	Status string
	// Progress 进度百分比 0~100。
	Progress int
	// ErrorCode 失败原因码；非失败态为空串。
	ErrorCode string
	// ErrorMsg 失败原因描述；非失败态为空串。
	ErrorMsg string
	// PointCodes 参与预测的点位清单。
	PointCodes []string
	// Periods 参与预测的预见期（1h / 3h / 6h / 12h）。
	Periods []string
	// ModelVersion 指定的模型版本；空串表示用当前生效版本。
	ModelVersion string
	// BeginTime / EndTime 时间区间（仿真时钟秒），按预测目标时刻过滤。
	// 0 表示不限。
	BeginTime int64
	EndTime   int64
	// ResultList 成功后的结果行，结构与 A-1 的 list 项一致。
	ResultList []AIWaterPrediction
	// CallbackURL 对方给的回调地址；非空则任务完成后推送。
	CallbackURL string
	// CallbackStatus 回调结果：ok / failed / skipped（非空回调地址才非空）。
	CallbackStatus string
	// CallbackMsg 回调失败原因。
	CallbackMsg string
	// SubmitTime 提交时刻（墙钟 Unix 秒）。
	SubmitTime int64
	// UpdateTime 最近更新时刻（墙钟 Unix 秒）。
	UpdateTime int64
}

// AIWaterPrediction 是 A-1 输出的一行：某点位、某预见期上的一个预测结果。
type AIWaterPrediction struct {
	// PointCode 点位编码（我方用 siteId，对面称 indexCode）。
	PointCode string `json:"pointCode"`
	// Period 预见期：1h / 3h / 6h / 12h。
	Period string `json:"period"`
	// PredictTime 预测目标时刻（仿真时钟秒）。
	PredictTime int64 `json:"predictTime"`
	// PredictLevel 预测水位（m，绝对高程，与 v3 的 level 同口径）。
	PredictLevel float64 `json:"predictLevel"`
	// RiskLevel 对外三级风险：low / medium / high。
	RiskLevel string `json:"riskLevel"`
	// Confidence 置信度 0~1，由置信带相对宽度换算。
	Confidence float64 `json:"confidence"`
	// ModelVersion 产出该结果的模型版本。
	ModelVersion string `json:"modelVersion"`
	// Revision 修正**前**的预测水位（m）。
	//
	// 保留修正前数值是条款 9-6「多源协同动态修正」的要求：
	// 修正值与原值必须同时可查，否则事后无法复盘「当时改了没有、改了多少」。
	Revision float64 `json:"revision"`
	// CorrectionID 修正记录标识，形如 {pointCode}:{period}:{modelVersion}。
	//
	// 它是幂等键：按「点位 + 时段 + 版本号」唯一，
	// 同一份修正被重复下发时不会产生第二条记录。
	// 不掺发布时刻——发布时刻每轮都变，掺进去键就不再唯一。
	CorrectionID string `json:"correctionId"`

	// ---- 以下为扩展字段，保留我方原始口径，避免信息在映射中丢失 ----

	// WarnLevel 我方内部四级预警：blue / yellow / orange / red / none。
	WarnLevel string `json:"warnLevel"`
	// Lower 置信区间下界（m）。
	Lower float64 `json:"lower"`
	// Upper 置信区间上界（m）。
	Upper float64 `json:"upper"`
	// Sigma 预测标准差（m）。
	Sigma float64 `json:"sigma"`
	// Correction 本次动态修正量（m，正为上调、负为下调）。
	Correction float64 `json:"correction"`
	// Gain 动态修正的指数加权增益。
	Gain float64 `json:"gain"`
	// Reason 修正/预测的可读原因。
	Reason string `json:"reason"`
}

// AIWaterEvent 是 A-9 收到的一条积水事件生命周期记录。
//
// 幂等键是 (EventID, Stage)：同一个事件的同一个阶段重复到达只留一条，
// 但同一事件的不同阶段（发现 / 复核 / 核销）都要留——那是生命周期的全部。
type AIWaterEvent struct {
	// EventID 事件标识（对方给）。
	EventID string
	// PointCode 点位编码。
	PointCode string
	// Stage 阶段：发现 / 复核 / 核销。
	Stage string
	// Operator 操作人。
	Operator string
	// OperateTime 操作时刻（对方给，真实时间 Unix 秒）。
	OperateTime int64
	// Conclusion 处置结论。
	Conclusion string
	// EvidenceURLs 佐证材料链接。
	EvidenceURLs []string
	// Source 来源：icm（对方推来）/ local（我方内部产生）。
	Source string
	// PayloadHash 原始报文摘要，用于排查「同 eventId 不同内容」的情况。
	PayloadHash string
	// ReceivedAt 我方收到时刻（墙钟 Unix 秒）。
	ReceivedAt int64
	// UpdatedAt 最近更新时刻（墙钟 Unix 秒）。
	UpdatedAt int64
}
