package httpapi

import (
	"net/http"
	"runtime/debug"
)

// stackOf 返回当前 goroutine 的调用栈（字符串）。
//
// 单独抽出来是为了让 Recover 中间件保持"只管兜住 panic"这一件事，
// 堆栈怎么取是另一个可变细节（未来要接 traceID 之类的也改这里）。
func stackOf() string {
	return string(debug.Stack())
}

// logRequest 让 AccessLog 以方法形式挂到 Server 上，路由表里写起来短一些。
func (s *Server) logRequest(next http.Handler) http.Handler {
	return AccessLog(s.log)(next)
}
