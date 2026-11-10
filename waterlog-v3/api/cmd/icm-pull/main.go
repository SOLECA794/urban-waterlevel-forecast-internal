// Command icm-pull 是「按对方接口复用」链路的独立手动/调度入口。
//
// 它**不属于 v3 主进程**：不注册路由、不启后台 goroutine、不改任何已上线行为。
// 缺省（未配置 WL_ICM_BASE_URL）时直接报错退出，保证 v3 与改造前完全一致。
//
// 用法：
//
//	WL_ICM_BASE_URL=https://<icm-host> \
//	WL_ICM_POINT_MAP='<indexCode>=S01,<indexCode2>=S02' \
//	WL_ICM_MONITOR_ITEM=wl \
//	WL_ICM_DEVICE_TYPE=<对方设备类型> \
//	go run ./cmd/icm-pull                       # 默认 dry-run，只拉+映射+报告
//
//	... go run ./cmd/icm-pull --push            # 显式写入 v3 /api/ingest/telemetry
//
// 时间基准：
//
//	--basis=real       （默认）真实 Unix 秒，仅适用于 v3 已切 1 倍速真实时钟
//	--basis=simulated  对齐到 --sim-now 指定的仿真时刻（demo 演示用）
//
// ⚠ 本命令未与对方平台联调（无测试地址/凭据），仅验证本地链路与协议适配正确性。
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"waterlog-v3/api/internal/icm"
)

func main() {
	var (
		push      = flag.Bool("push", false, "显式写入 v3 /api/ingest/telemetry（默认 dry-run）")
		basis     = flag.String("basis", string(icm.TimeBasisReal), "时间基准：real / simulated")
		simNow    = flag.Int64("sim-now", 0, "simulated 基准下的 v3 仿真时刻（Unix 秒）")
		points    = flag.String("points", "", "编码对照表覆盖（indexCode=siteId,...），缺省读 WL_ICM_POINT_MAP")
		indexes   = flag.String("index-codes", "", "只拉这些设备编码（逗号分隔）；空=全部")
		levelItem = flag.String("level-item", "", "水位监测项编码覆盖（默认 WL_ICM_MONITOR_ITEM）")
		rainItem  = flag.String("rain-item", "", "雨量监测项编码覆盖（默认 WL_ICM_MONITOR_ITEM_RAIN）")
		timeout   = flag.Duration("timeout", 30*time.Second, "整体超时")
	)
	flag.Parse()

	cfg := icm.Load()
	if !cfg.Enabled() {
		fmt.Fprintln(os.Stderr, "未启用：缺少 WL_ICM_BASE_URL。本单元缺省不发起任何出站请求，v3 行为保持不变。")
		os.Exit(2)
	}

	pmRaw := *points
	if pmRaw == "" {
		pmRaw = os.Getenv("WL_ICM_POINT_MAP")
	}
	pointMap := icm.ParsePointMap(pmRaw)

	var codes []string
	if s := strings.TrimSpace(*indexes); s != "" {
		for _, c := range strings.Split(s, ",") {
			if c = strings.TrimSpace(c); c != "" {
				codes = append(codes, c)
			}
		}
	}

	mc := icm.MapConfig{
		LevelItem: *levelItem,
		RainItem:  *rainItem,
		Basis:     icm.TimeBasis(*basis),
	}
	if mc.Basis == icm.TimeBasisSimulated {
		if *simNow <= 0 {
			fmt.Fprintln(os.Stderr, "--basis=simulated 需要 --sim-now（Unix 秒）")
			os.Exit(2)
		}
		v := *simNow
		mc.SimNow = func() int64 { return v }
	}
	if err := icm.ValidateMapConfig(cfg, mc); err != nil {
		fmt.Fprintln(os.Stderr, "映射配置错误:", err)
		os.Exit(2)
	}

	client := icm.NewClient(cfg)
	client.SetLogger(func(format string, args ...any) {
		fmt.Fprintf(os.Stderr, "[icm] "+format+"\n", args...)
	})
	src := icm.NewRealtimeSource(client, cfg.DeviceType, codes)

	var sink icm.Sink = &icm.DryRunSink{}
	if *push {
		sink = icm.NewIngestSink(cfg)
	}

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()

	rep, err := icm.SyncOnce(ctx, src, cfg, pointMap, mc, sink)
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(rep)
	if err != nil {
		fmt.Fprintln(os.Stderr, "同步失败:", err)
		os.Exit(1)
	}
}
