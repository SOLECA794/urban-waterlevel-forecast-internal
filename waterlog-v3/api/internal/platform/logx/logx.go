// Package logx 初始化 slog。
//
// 统一在这里决定日志的形态，业务代码只拿 *slog.Logger，不关心输出格式。
// 默认文本（人读），WL_LOG_FORMAT=json 时输出 JSON（机器采集）。
package logx

import (
	"log/slog"
	"os"
	"strings"
)

// New 创建日志器。format 为 "json" 时输出 JSON，其余（含空串）输出文本。
func New(format string) *slog.Logger {
	opts := &slog.HandlerOptions{Level: slog.LevelInfo}
	var h slog.Handler
	if strings.EqualFold(strings.TrimSpace(format), "json") {
		h = slog.NewJSONHandler(os.Stdout, opts)
	} else {
		h = slog.NewTextHandler(os.Stdout, opts)
	}
	return slog.New(h)
}
