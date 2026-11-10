package icm

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

// ---------------------------------------------------------------- 路径常量
//
// 【事实】以下 12 条为《水涝监测软件部分接口技术方案.xlsx》表一，路径逐条在
// 《Infovision iCM 智慧城管平台 V3.0.0接口文档.docx》中核对存在（设计文档 §3.1）。
// 复用时按对方原样，不在我方另造路径。
const (
	PathRealtimeData      = "/api/cisrm/v1/device/queryRealtimeDataByPage"
	PathHistoryData       = "/api/cisrm/v1/device/queryHistoryDataByPage"
	PathFindDevices       = "/api/cisrm/v1/device/findByParams"
	PathRunningStatus     = "/api/cisrm/v1/device/queryRunningStatus"
	PathRegions           = "/api/resource/v1/regions"
	PathSubRegions        = "/api/resource/v1/regions/subRegions"
	PathCameras           = "/api/resource/v1/cameras"
	PathCamerasBySpatial  = "/api/resource/v1/camera/getCamerasBySpatialIndexWithPage"
	PathPreviewURLs       = "/api/video/v1/cameras/previewURLs"
	PathPlaybackURLs      = "/api/video/v1/cameras/playbackURLs"
	PathVideoQuality      = "/api/nms/v1/vqd/list"
	PathEventSubscription = "/api/eventService/v1/eventSubscriptionByEventTypes"
	PathSubscriptionView  = "/api/eventService/v1/eventSubscriptionView"
)

// ---------------------------------------------------------------- 通用标量
//
// ICM 部分数值字段在不同接口里会写成 number 或 string number，统一兼容，
// 避免因为一个字段类型不同就整页解析失败（§3.3 差异 2）。
type flexFloat float64

func (f *flexFloat) UnmarshalJSON(b []byte) error {
	s := strings.TrimSpace(string(b))
	if s == "" || s == "null" {
		*f = 0
		return nil
	}
	s = strings.Trim(s, `"`)
	if s == "" {
		*f = 0
		return nil
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return nil // 非数值按 0 处理，不让单个脏值拖垮整页
	}
	*f = flexFloat(v)
	return nil
}

// ---------------------------------------------------------------- R1 / R2 监测数据
//
// ⚠ 字段名按 ICM 原件（设计文档 §3.2）：
//
//	入参是 deviceType(必填) + indexCodes[] + beginTime/endTime + isDesc，
//	不是基础文档简写的 deviceIds / monitorItemCodes；
//	出参固定字段只有 id / indexCode / monitorTime / createTime，
//	「监测值」是**监测项编码作为动态字段名**（示例 wl），且 R1 为 String、
//	R2 为 Number —— 所以不能用固定 tag 的 struct，必须保留原始对象。
type MonitorDataQuery struct {
	DeviceType string   `json:"deviceType"`
	IndexCodes []string `json:"indexCodes,omitempty"`
	BeginTime  string   `json:"beginTime,omitempty"`
	EndTime    string   `json:"endTime,omitempty"`
	IsDesc     bool     `json:"isDesc,omitempty"`
	PageNo     int      `json:"pageNo"`
	PageSize   int      `json:"pageSize"`
}

// MonitorRecord 是一条监测记录。Raw 保留完整对象，供 ValueOf(监测项编码) 取值。
type MonitorRecord struct {
	ID          string `json:"id"`
	IndexCode   string `json:"indexCode"`
	MonitorTime string `json:"monitorTime"`
	CreateTime  string `json:"createTime"`

	Raw map[string]json.RawMessage `json:"-"`
}

func (r *MonitorRecord) UnmarshalJSON(b []byte) error {
	type plain MonitorRecord
	var p plain
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	*r = MonitorRecord(p)
	return json.Unmarshal(b, &r.Raw)
}

// ValueOf 按监测项编码取监测值，兼容 R1 的字符串与 R2 的数字。
// 例如 ICM 返回 {"wl":"1.23", ...} 时 ValueOf("wl") = 1.23。
func (r MonitorRecord) ValueOf(itemCode string) (float64, bool) {
	if itemCode == "" || r.Raw == nil {
		return 0, false
	}
	raw, ok := r.Raw[itemCode]
	if !ok {
		return 0, false
	}
	var f flexFloat
	if err := json.Unmarshal(raw, &f); err != nil {
		return 0, false
	}
	return float64(f), true
}

// QueryRealtimeData 分页查询设备实时监测数据（R1）。
func (c *Client) QueryRealtimeData(ctx context.Context, q MonitorDataQuery) ([]MonitorRecord, error) {
	return fetchAll[MonitorRecord](ctx, c, PathRealtimeData, func(page int) any {
		q.PageNo, q.PageSize = page, c.cfg.PageSize
		return q
	})
}

// QueryHistoryData 分页查询设备历史监测数据（R2）。跨度 >7 天应由调用方拆区间串行。
func (c *Client) QueryHistoryData(ctx context.Context, q MonitorDataQuery) ([]MonitorRecord, error) {
	return fetchAll[MonitorRecord](ctx, c, PathHistoryData, func(page int) any {
		q.PageNo, q.PageSize = page, c.cfg.PageSize
		return q
	})
}

// ---------------------------------------------------------------- R3 / R4 设备台账与运行状态

type DeviceQuery struct {
	MenuCode         string   `json:"menuCode,omitempty"`
	DeviceTypes      []string `json:"deviceTypes,omitempty"`
	DeviceIds        []string `json:"deviceIds,omitempty"`
	DeviceName       string   `json:"deviceName,omitempty"`
	RegionCode       string   `json:"regionCode,omitempty"`
	IncludeSubRegion bool     `json:"includeSubRegion,omitempty"`
	OnlineStatus     string   `json:"onlineStatus,omitempty"`
	PageNo           int      `json:"pageNo"`
	PageSize         int      `json:"pageSize"`
}

// DeviceInfo 只声明本项目需要的字段；其余按 §3.3 差异 2「忽略未知字段」处理。
type DeviceInfo struct {
	ID             string    `json:"id"`
	IndexCode      string    `json:"indexCode"`
	MenuCode       string    `json:"menuCode"`
	DeviceName     string    `json:"deviceName"`
	DeviceType     string    `json:"deviceType"`
	DeviceTypeName string    `json:"deviceTypeName"`
	RegionCode     string    `json:"regionCode"`
	RegionName     string    `json:"regionName"`
	RegionPath     string    `json:"regionPath"`
	RegionPathName string    `json:"regionPathName"`
	Address        string    `json:"address"`
	DomainID       string    `json:"domainId"`
	Longitude      flexFloat `json:"longitude"`
	Latitude       flexFloat `json:"latitude"`
	OnlineStatus   string    `json:"onlineStatus"`
	IsVss          bool      `json:"isVss"`
	PicUrls        []string  `json:"picUrls"`
}

// RunningStatusItem 是 R4 的实际出参形态：ICM 原件没有独立 battery/voltage/
// signalStrength 字段，只有 runningStatus[]{code,name}（§3.2 R4）。
type RunningStatusItem struct {
	Code string `json:"code"`
	Name string `json:"name"`
}

type DeviceRunning struct {
	ID            string              `json:"id"`
	IndexCode     string              `json:"indexCode"`
	DeviceName    string              `json:"deviceName"`
	DeviceType    string              `json:"deviceType"`
	RegionCode    string              `json:"regionCode"`
	RegionName    string              `json:"regionName"`
	OnlineStatus  string              `json:"onlineStatus"`
	RunningStatus []RunningStatusItem `json:"runningStatus"`
}

// FindDevices 分页查询设备基本信息（R3）。
func (c *Client) FindDevices(ctx context.Context, q DeviceQuery) ([]DeviceInfo, error) {
	return fetchAll[DeviceInfo](ctx, c, PathFindDevices, func(page int) any {
		q.PageNo, q.PageSize = page, c.cfg.PageSize
		return q
	})
}

// QueryRunningStatus 分页查询设备运行状态（R4）。
func (c *Client) QueryRunningStatus(ctx context.Context, q DeviceQuery) ([]DeviceRunning, error) {
	return fetchAll[DeviceRunning](ctx, c, PathRunningStatus, func(page int) any {
		q.PageNo, q.PageSize = page, c.cfg.PageSize
		return q
	})
}

// ---------------------------------------------------------------- R5 / R6 区域

type Region struct {
	IndexCode         string `json:"indexCode"`
	Name              string `json:"name"`
	ParentIndexCode   string `json:"parentIndexCode"`
	TreeCode          string `json:"treeCode"`
	ExternalIndexCode string `json:"externalIndexCode"`
	CascadeCode       string `json:"cascadeCode"`
}

type RegionQuery struct {
	PageNo   int    `json:"pageNo"`
	PageSize int    `json:"pageSize"`
	TreeCode string `json:"treeCode"` // "0" = 国标树（§8 Q2）
}

type SubRegionQuery struct {
	ParentIndexCode string `json:"parentIndexCode"`
	TreeCode        string `json:"treeCode"`
	// ⚠ R6 原件无分页参数，不要加 pageNo/pageSize（§3.2 R6）
}

// ListRegions 分页获取区域列表（R5）。
func (c *Client) ListRegions(ctx context.Context, treeCode string) ([]Region, error) {
	if treeCode == "" {
		treeCode = c.cfg.TreeCode
	}
	return fetchAll[Region](ctx, c, PathRegions, func(page int) any {
		return RegionQuery{PageNo: page, PageSize: c.cfg.PageSize, TreeCode: treeCode}
	})
}

// ListSubRegions 获取下一级区域列表（R6）。对方 data 可能是数组或 {list:[]}，
// 两种都兼容；无标准分页壳，故不做分页循环。
func (c *Client) ListSubRegions(ctx context.Context, parentIndexCode, treeCode string) ([]Region, error) {
	if treeCode == "" {
		treeCode = c.cfg.TreeCode
	}
	raw, err := c.DoRaw(ctx, http.MethodPost, PathSubRegions, SubRegionQuery{
		ParentIndexCode: parentIndexCode, TreeCode: treeCode,
	})
	if err != nil {
		return nil, err
	}
	return decodeRegionData(raw)
}

func decodeRegionData(raw json.RawMessage) ([]Region, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return []Region{}, nil
	}
	var list []Region
	if err := json.Unmarshal(raw, &list); err == nil {
		return list, nil
	}
	var wrapped struct {
		List []Region `json:"list"`
	}
	if err := json.Unmarshal(raw, &wrapped); err != nil {
		return nil, err
	}
	return wrapped.List, nil
}

// ---------------------------------------------------------------- R7 / R8 监控点

// Camera 只声明本项目需要的字段（原件共 44 项），坐标系为 WGS84（§6.1）。
// 注意出参是 cameraIndexCode / name，不是基础文档简写的 cameraName。
type Camera struct {
	CameraIndexCode string    `json:"cameraIndexCode"`
	GbIndexCode     string    `json:"gbIndexCode"`
	Name            string    `json:"name"`
	DeviceIndexCode string    `json:"deviceIndexCode"`
	Longitude       flexFloat `json:"longitude"`
	Latitude        flexFloat `json:"latitude"`
	Altitude        flexFloat `json:"altitude"`
	Pixel           string    `json:"pixel"`
	CameraType      string    `json:"cameraType"`
	InstallPlace    string    `json:"installPlace"`
	Status          string    `json:"status"`
	UnitIndexCode   string    `json:"unitIndexCode"`
	TreatyType      string    `json:"treatyType"`
	CreateTime      string    `json:"createTime"`
	UpdateTime      string    `json:"updateTime"`
}

type CameraQuery struct {
	PageNo   int    `json:"pageNo"`
	PageSize int    `json:"pageSize"`
	TreeCode string `json:"treeCode"`
}

// SpatialCameraQuery 对应 R8。geometryType: Circle / Point / Polygon；
// distance 单位为米，wkt 为 OGC POLYGON。
type SpatialCameraQuery struct {
	GeometryType string    `json:"geometryType"`
	Longitude    flexFloat `json:"longitude,omitempty"`
	Latitude     flexFloat `json:"latitude,omitempty"`
	Distance     flexFloat `json:"distance,omitempty"`
	WKT          string    `json:"wkt,omitempty"`
	TreeCode     string    `json:"treeCode,omitempty"`
	PageNo       int       `json:"pageNo"`
	PageSize     int       `json:"pageSize"`
}

// ListCameras 分页获取监控点资源（R7）。
func (c *Client) ListCameras(ctx context.Context, treeCode string) ([]Camera, error) {
	if treeCode == "" {
		treeCode = c.cfg.TreeCode
	}
	return fetchAll[Camera](ctx, c, PathCameras, func(page int) any {
		return CameraQuery{PageNo: page, PageSize: c.cfg.PageSize, TreeCode: treeCode}
	})
}

// FindCamerasBySpatial 按空间条件分页查询监控点（R8）。
func (c *Client) FindCamerasBySpatial(ctx context.Context, q SpatialCameraQuery) ([]Camera, error) {
	if q.TreeCode == "" {
		q.TreeCode = c.cfg.TreeCode
	}
	return fetchAll[Camera](ctx, c, PathCamerasBySpatial, func(page int) any {
		q.PageNo, q.PageSize = page, c.cfg.PageSize
		return q
	})
}

// ---------------------------------------------------------------- R9 / R10 取流

type PreviewURLQuery struct {
	CameraIndexCode string `json:"cameraIndexCode"`     // 必填
	StreamType      int    `json:"streamType"`          // 0 主码流 / 1 子码流
	Protocol        string `json:"protocol,omitempty"`  // rtsp/rtmp/hls/ws
	Transmode       int    `json:"transmode,omitempty"` // 0 UDP / 1 TCP
	Expand          string `json:"expand,omitempty"`
}

// PreviewURLResult 原件只返回 data.url，**没有 expireTime**（§3.2 R9）。
// 因此 URL 不落库长期缓存，过期重取（§7.2）。
type PreviewURLResult struct {
	URL string `json:"url"`
}

type PlaybackURLQuery struct {
	CameraIndexCode    string `json:"cameraIndexCode"`
	BeginTime          string `json:"beginTime"`
	EndTime            string `json:"endTime"`
	RecordLocation     string `json:"recordLocation,omitempty"`
	Protocol           string `json:"protocol,omitempty"`
	NeedReturnClipInfo bool   `json:"needReturnClipInfo,omitempty"`
	UUID               string `json:"uuid,omitempty"`
	Expand             string `json:"expand,omitempty"`
	// ⚠ 原件无 streamType、无 expireTime（§3.2 R10）
}

type PlaybackClip struct {
	BeginTime string    `json:"beginTime"`
	EndTime   string    `json:"endTime"`
	Size      flexFloat `json:"size"`
}

type PlaybackURLResult struct {
	URL  string         `json:"url"`
	UUID string         `json:"uuid"`
	List []PlaybackClip `json:"list"`
}

// GetPreviewURL 获取监控点预览取流 URL（R9）。
func (c *Client) GetPreviewURL(ctx context.Context, q PreviewURLQuery) (PreviewURLResult, error) {
	var out PreviewURLResult
	err := c.Do(ctx, http.MethodPost, PathPreviewURLs, q, &out)
	return out, err
}

// GetPlaybackURL 获取监控点回放取流 URL（R10）。
func (c *Client) GetPlaybackURL(ctx context.Context, q PlaybackURLQuery) (PlaybackURLResult, error) {
	var out PlaybackURLResult
	err := c.Do(ctx, http.MethodPost, PathPlaybackURLs, q, &out)
	return out, err
}

// ---------------------------------------------------------------- R11 视频质量诊断

// VQDQuery 原件**无时间范围入参**，只有 pageNo/pageSize/indexCodes[]（§3.2 R11）。
type VQDQuery struct {
	PageNo     int      `json:"pageNo"`
	PageSize   int      `json:"pageSize"`
	IndexCodes []string `json:"indexCodes"`
}

// VideoQuality 保留 inspectDate / inspectResult / resolution / picUrl，
// 以及 sc*Result 系列指标（原件有十几项，按前缀收集，不逐一写死）。
type VideoQuality struct {
	IndexCode     string `json:"indexCode"`
	InspectDate   string `json:"inspectDate"`
	InspectResult string `json:"inspectResult"`
	Resolution    string `json:"resolution"`
	PicURL        string `json:"picUrl"`

	Indicators map[string]json.RawMessage `json:"-"`
}

func (v *VideoQuality) UnmarshalJSON(b []byte) error {
	type plain VideoQuality
	var p plain
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	*v = VideoQuality(p)
	var all map[string]json.RawMessage
	if err := json.Unmarshal(b, &all); err != nil {
		return err
	}
	v.Indicators = make(map[string]json.RawMessage)
	for k, val := range all {
		if strings.HasPrefix(k, "sc") && strings.HasSuffix(k, "Result") {
			v.Indicators[k] = val
		}
	}
	return nil
}

// QueryVideoQuality 根据监控点列表查询视频质量诊断结果（R11）。
func (c *Client) QueryVideoQuality(ctx context.Context, q VQDQuery) ([]VideoQuality, error) {
	return fetchAll[VideoQuality](ctx, c, PathVideoQuality, func(page int) any {
		q.PageNo, q.PageSize = page, c.cfg.PageSize
		return q
	})
}

// ---------------------------------------------------------------- R12 事件订阅

// EventSubscription 全部按 ICM 原件（§3.2 R12）：
//
//	eventTypes[] 为整型字符串（≤256，范围 [100000,2147483647]）；
//	subWay 1=回调 / 2=MQTT；eventDest 是回调 URL（不是 callbackUrl）；
//	subType 0=原始 / 1=联动 / 2=全部。
//	⚠ 原件**无 subscribeId**。
type EventSubscription struct {
	EventTypes []string `json:"eventTypes"`
	SubWay     int      `json:"subWay"`
	EventDest  string   `json:"eventDest,omitempty"`
	SubType    int      `json:"subType"`
	EventLvl   []string `json:"eventLvl,omitempty"`
}

// SubscriptionMQTT 只在 subWay=2 时返回；回调方式 data 无返回值。
type SubscriptionMQTT struct {
	Host     string `json:"host"`
	UserName string `json:"userName"`
	Password string `json:"password"`
	List     []struct {
		ClientID  string `json:"clientId"`
		TopicName string `json:"topicName"`
		EventType string `json:"eventType"`
	} `json:"list"`
}

// SubscribeEvents 按事件类型订阅（R12）。
// 返回 nil 表示回调方式订阅成功（对方 data 无返回值）；非 nil 为 MQTT 连接信息。
//
// ⚠ 这是**非幂等**接口：超时后应先查 R15 订阅状态再决定是否重提（§3.5），
// 本方法内部不做自动重试决策，Do 的重试仅覆盖网络/5xx。
func (c *Client) SubscribeEvents(ctx context.Context, q EventSubscription) (*SubscriptionMQTT, error) {
	raw, err := c.DoRaw(ctx, http.MethodPost, PathEventSubscription, q)
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 || string(raw) == "null" || string(raw) == "{}" {
		return nil, nil
	}
	var out SubscriptionMQTT
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// QuerySubscriptionView 查询事件订阅状态（R15，补充复用接口）。
// 入 subWay；出 data.detail[]{eventTypes,eventDest}。R12 超时后先查这里。
func (c *Client) QuerySubscriptionView(ctx context.Context, subWay int) (json.RawMessage, error) {
	return c.DoRaw(ctx, http.MethodPost, PathSubscriptionView, map[string]any{"subWay": subWay})
}
