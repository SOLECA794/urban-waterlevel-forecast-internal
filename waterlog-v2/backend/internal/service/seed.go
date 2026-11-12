package service

import (
	"encoding/json"
	"log"
	"time"

	"waterlog/v2/internal/model"
	"waterlog/v2/internal/repo"
)

// Seed 初始化演示数据（幂等：仅在对应表为空时写入）。
// 设备/画像/规则/大屏四类种子，遥测由 Simulator 产生，保证链路真实。
func Seed(r *repo.Repo) error {
	profiles, err := r.ListProfiles()
	if err != nil {
		return err
	}
	if len(profiles) > 0 {
		return nil // 已初始化
	}
	log.Printf("[seed] 首次启动，写入演示数据")

	p1 := &model.DeviceProfile{Name: "一体化内涝监测站", Category: "integrated",
		Keys: []string{"water_level", "rainfall"}, Description: "水位 + 雨量一体采集"}
	p2 := &model.DeviceProfile{Name: "雷达水位计", Category: "water_level",
		Keys: []string{"water_level"}, Description: "非接触式雷达水位"}
	p3 := &model.DeviceProfile{Name: "翻斗雨量计", Category: "rainfall",
		Keys: []string{"rainfall"}, Description: "分钟级降雨量"}
	for _, p := range []*model.DeviceProfile{p1, p2, p3} {
		if err := r.CreateProfile(p); err != nil {
			return err
		}
	}

	devices := []*model.Device{
		{ProfileID: p1.ID, Name: "文一路隧道", Code: "WL001", Lat: 30.2886, Lon: 120.1293, Address: "西湖区文一路", Status: model.DeviceOffline, Enabled: true},
		{ProfileID: p2.ID, Name: "天目山路涵洞", Code: "WL002", Lat: 30.2729, Lon: 120.1181, Address: "西湖区天目山路", Status: model.DeviceOffline, Enabled: true},
		{ProfileID: p1.ID, Name: "延安路立交", Code: "WL003", Lat: 30.2588, Lon: 120.1614, Address: "上城区延安路", Status: model.DeviceOffline, Enabled: true},
		{ProfileID: p2.ID, Name: "钱江路泵站", Code: "WL004", Lat: 30.2411, Lon: 120.1928, Address: "上城区钱江路", Status: model.DeviceOffline, Enabled: true},
		{ProfileID: p3.ID, Name: "城西雨量站", Code: "RG001", Lat: 30.2801, Lon: 120.0950, Address: "西湖区城西", Status: model.DeviceOffline, Enabled: true},
		{ProfileID: p1.ID, Name: "秋涛路下穿", Code: "WL005", Lat: 30.2455, Lon: 120.2051, Address: "上城区秋涛路", Status: model.DeviceOffline, Enabled: true},
	}
	for _, d := range devices {
		if err := r.CreateDevice(d); err != nil {
			return err
		}
	}

	chain := &model.RuleChain{Name: "内涝分级预警", Description: "水位阈值 + 持续时长 → 四级预警", Enabled: true}
	if err := r.CreateChain(chain); err != nil {
		return err
	}
	nodes := []*model.RuleNode{
		{ChainID: chain.ID, Name: "蓝色预警（积水初现）", Metric: "water_level", Op: "gte", Threshold: 1.30, DurationSec: 0,
			LevelKey: "blue", LevelRank: 1, Severity: "info", ActionsList: []string{"sse", "log"}, Priority: 10, Enabled: true},
		{ChainID: chain.ID, Name: "黄色预警（积水发展）", Metric: "water_level", Op: "gte", Threshold: 1.50, DurationSec: 30,
			LevelKey: "yellow", LevelRank: 2, Severity: "warning", ActionsList: []string{"sse", "log"}, Priority: 20, Enabled: true},
		{ChainID: chain.ID, Name: "橙色预警（影响通行）", Metric: "water_level", Op: "gte", Threshold: 1.70, DurationSec: 30,
			LevelKey: "orange", LevelRank: 3, Severity: "major", ActionsList: []string{"sse", "log"}, Priority: 30, Enabled: true},
		{ChainID: chain.ID, Name: "红色预警（阻断交通）", Metric: "water_level", Op: "gte", Threshold: 1.90, DurationSec: 30,
			LevelKey: "red", LevelRank: 4, Severity: "critical", ActionsList: []string{"sse", "log"}, Priority: 40, Enabled: true},
	}
	for _, n := range nodes {
		if err := r.CreateNode(n); err != nil {
			return err
		}
	}

	rainChain := &model.RuleChain{Name: "强降雨监测", Description: "分钟雨强超阈值触发提示", Enabled: true}
	if err := r.CreateChain(rainChain); err != nil {
		return err
	}
	if err := r.CreateNode(&model.RuleNode{
		ChainID: rainChain.ID, Name: "短时强降雨", Metric: "rainfall", Op: "gte", Threshold: 5,
		DurationSec: 0, LevelKey: "yellow", LevelRank: 2, Severity: "warning",
		ActionsList: []string{"sse", "log"}, Priority: 10, Enabled: true,
	}); err != nil {
		return err
	}

	// 默认大屏：4 个 KPI + 1 条趋势 + 1 个告警列表
	layout := []model.WidgetLayout{
		{Key: "kpi-level", X: 0, Y: 0, W: 3, H: 2},
		{Key: "kpi-alarm", X: 3, Y: 0, W: 3, H: 2},
		{Key: "kpi-unack", X: 6, Y: 0, W: 3, H: 2},
		{Key: "kpi-device", X: 9, Y: 0, W: 3, H: 2},
		{Key: "chart-trend", X: 0, Y: 2, W: 8, H: 6},
		{Key: "list-alarm", X: 8, Y: 2, W: 4, H: 6},
	}
	widgets := []model.Widget{
		{Key: "kpi-level", Type: "kpi", Title: "最高水位", Metric: "water_level", DeviceIDs: []int64{devices[0].ID}},
		{Key: "kpi-alarm", Type: "kpi", Title: "生效告警"},
		{Key: "kpi-unack", Type: "kpi", Title: "待确认"},
		{Key: "kpi-device", Type: "kpi", Title: "在线设备"},
		{Key: "chart-trend", Type: "line", Title: "水位趋势（近 3 小时）", Metric: "water_level", DeviceIDs: []int64{devices[0].ID, devices[2].ID, devices[5].ID}},
		{Key: "list-alarm", Type: "alarm-list", Title: "实时告警"},
	}
	layoutJSON, _ := json.Marshal(layout)
	widgetsJSON, _ := json.Marshal(widgets)
	if _, err := r.CreateDashboard(&model.Dashboard{
		Name: "城市内涝监测大屏", IsDefault: true, Layout: string(layoutJSON), Widgets: string(widgetsJSON),
		UpdatedAt: time.Now().Unix(),
	}); err != nil {
		return err
	}
	log.Printf("[seed] 完成：画像 3 / 设备 %d / 规则链 2 / 大屏 1", len(devices))
	return nil
}
