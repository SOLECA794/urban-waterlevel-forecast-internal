package service

import "waterlog-v3/api/internal/domain"

// 内置站点副本：引擎没起来时 Go 也能独立运行（改前端样式、演示静态页面）。
// 数值与 engine/app/config.py 的 SITES 保持一致，改动要两边同步。

// BuiltinSites 返回内置站点清单的副本，避免调用方改到包级变量。
func BuiltinSites() []domain.SiteMeta {
	out := make([]domain.SiteMeta, len(builtinSites))
	copy(out, builtinSites)
	return out
}

var builtinSites = []domain.SiteMeta{
	{SiteID: "S01", Name: "天长北路下穿隧道", District: "东城街道", Lon: 121.2650, Lat: 28.6480, BaseLevel: 7.85, Thresholds: []float64{0.05, 0.15, 0.30, 0.45}, Kind: "tunnel", CatchmentHa: 95, PondHa: 16.0, Impervious: 0.86, Drainage: 26},
	{SiteID: "S02", Name: "东城立交桥下", District: "东城街道", Lon: 121.2830, Lat: 28.6420, BaseLevel: 6.40, Thresholds: []float64{0.05, 0.15, 0.30, 0.50}, Kind: "interchange", CatchmentHa: 140, PondHa: 22.0, Impervious: 0.78, Drainage: 30},
	{SiteID: "S03", Name: "九峰公园西低洼段", District: "东城街道", Lon: 121.2520, Lat: 28.6320, BaseLevel: 5.20, Thresholds: []float64{0.08, 0.20, 0.35, 0.55}, Kind: "park", CatchmentHa: 110, PondHa: 26.0, Impervious: 0.62, Drainage: 34},
	{SiteID: "S04", Name: "永宁江滨江泵站", District: "西城街道", Lon: 121.2350, Lat: 28.6520, BaseLevel: 4.10, Thresholds: []float64{0.06, 0.18, 0.32, 0.48}, Kind: "riverside", CatchmentHa: 170, PondHa: 34.0, Impervious: 0.72, Drainage: 40},
	{SiteID: "S05", Name: "新前模具小镇北闸", District: "新前街道", Lon: 121.2050, Lat: 28.6800, BaseLevel: 8.90, Thresholds: []float64{0.05, 0.16, 0.28, 0.42}, Kind: "industrial", CatchmentHa: 210, PondHa: 30.0, Impervious: 0.80, Drainage: 36},
	{SiteID: "S06", Name: "桥上街老巷口", District: "西城街道", Lon: 121.2450, Lat: 28.6600, BaseLevel: 9.30, Thresholds: []float64{0.04, 0.12, 0.25, 0.38}, Kind: "oldtown", CatchmentHa: 70, PondHa: 12.0, Impervious: 0.74, Drainage: 24},
	{SiteID: "S07", Name: "台州站站前广场", District: "北城街道", Lon: 121.2700, Lat: 28.6820, BaseLevel: 11.20, Thresholds: []float64{0.06, 0.18, 0.30, 0.46}, Kind: "plaza", CatchmentHa: 160, PondHa: 28.0, Impervious: 0.88, Drainage: 32},
	{SiteID: "S08", Name: "西城快速路涵洞", District: "西城街道", Lon: 121.2180, Lat: 28.6390, BaseLevel: 12.50, Thresholds: []float64{0.05, 0.14, 0.26, 0.40}, Kind: "culvert", CatchmentHa: 85, PondHa: 14.0, Impervious: 0.82, Drainage: 22},
	{SiteID: "S09", Name: "黄岩体育馆周边", District: "南城街道", Lon: 121.2600, Lat: 28.6200, BaseLevel: 15.80, Thresholds: []float64{0.07, 0.19, 0.33, 0.50}, Kind: "campus", CatchmentHa: 130, PondHa: 24.0, Impervious: 0.70, Drainage: 38},
	{SiteID: "S10", Name: "南城永丰河排水渠", District: "南城街道", Lon: 121.2800, Lat: 28.6080, BaseLevel: 3.60, Thresholds: []float64{0.10, 0.22, 0.38, 0.58}, Kind: "channel", CatchmentHa: 240, PondHa: 40.0, Impervious: 0.55, Drainage: 45},
}
