// Package plugin 扩展点契约：数据源与预测模型的可插拔接口。
// 与 ThingsPanel 的协议插件、ThingsBoard 的遥测适配层对齐：平台只依赖接口，实现可替换。
package plugin

import (
	"context"

	"waterlog/v2/internal/model"
)

// DataSource 数据源插件：把任意协议（HTTP/MQTT/Modbus/SL651）的数据统一为 model.Sample。
// EXT-POINT(DATASOURCE): 新增真实数据源时实现本接口，注册到 main 的采集循环即可，
// 规则引擎、告警、前端无需任何改动。当前内置实现：Simulator（service/simulator.go）。
type DataSource interface {
	// Name 数据源标识（写入遥测来源字段与日志）。
	Name() string
	// Start 启动采集；sample 回调把数据送入遥测管道。返回时表示启动完成（可长期阻塞则由实现自行起协程）。
	Start(ctx context.Context, emit func(samples []model.Sample) error) error
	// Stop 优雅停止。
	Stop(ctx context.Context) error
}

// ForecastModel 预测模型插件：输入历史序列，输出逐点预测与置信区间。
// EXT-POINT(MODEL): 接入 Prophet/LightGBM/TCN 时实现本接口并替换 service.ForecastService 的默认实现。
// 注意：本期为课程 demo，默认实现为线性外推（service/forecast.go），不考核精度。
type ForecastModel interface {
	// Name 模型名（前端展示，如 "LinearResponse"）。
	Name() string
	// Version 版本号（如 "v1.0"）。
	Version() string
	// Predict 预测：history 为升序历史点，horizonMin 预见期，stepMin 步长。
	Predict(ctx context.Context, history []model.Telemetry, horizonMin, stepMin int) ([]Point, error)
}

// Point 预测点。
type Point struct {
	Ts    int64   `json:"ts"`
	Value float64 `json:"value"`
	Lower float64 `json:"lower"`
	Upper float64 `json:"upper"`
}
