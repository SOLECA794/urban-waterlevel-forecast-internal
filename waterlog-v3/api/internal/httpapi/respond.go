// Package httpapi 是 HTTP 适配层：只做"解析参数 → 调 service → 写 JSON"。
// 路由、中间件、响应格式、SSE 都在这里，业务判断一律下沉到 service。
package httpapi

import (
	"encoding/json"
	"net/http"
)

// writeJSON 是所有成功响应的唯一出口：统一 Content-Type 与换行编码。
func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// fail 是所有错误响应的唯一出口：{"error": "..."}。
// 文案是前端契约的一部分，不能改写。
func fail(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}
