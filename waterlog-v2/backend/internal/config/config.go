// Package config 环境变量配置（12-Factor）。
package config

import (
	"os"
	"strconv"
	"strings"
)

// Settings 全部运行配置。
type Settings struct {
	AppName        string
	Addr           string
	DBPath         string
	DemoMode       bool
	SimIntervalSec int
	CORSOrigins    []string
	RetentionHours int
	// AlarmCooldownSec 同设备同规则解除后的重复触发冷却窗口（秒）。
	// 工程语义：防抖，避免水位在阈值附近抖动时反复告警。
	AlarmCooldownSec int
}

// Load 读取环境变量，缺省值适配本地与服务器单机部署。
func Load() *Settings {
	return &Settings{
		AppName:        env("APP_NAME", "waterlog-v2"),
		Addr:           env("ADDR", ":8101"),
		DBPath:         env("DB_PATH", "data/v2.db"),
		DemoMode:       envBool("DEMO_MODE", true),
		SimIntervalSec: envInt("SIM_INTERVAL_SEC", 5),
		CORSOrigins:    splitCSV(env("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173,http://localhost:8102")),
		RetentionHours: envInt("RETENTION_HOURS", 72),
		AlarmCooldownSec: envInt("ALARM_COOLDOWN_SEC", 180),
	}
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envBool(k string, def bool) bool {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return def
	}
	return b
}

func envInt(k string, def int) int {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return def
	}
	return n
}

func splitCSV(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
