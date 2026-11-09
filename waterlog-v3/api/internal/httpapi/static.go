package httpapi

import (
	"fmt"
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"
)

// mountStatic 托管前端构建产物：单端口跑完，不需要额外 web server。
//
// 前端是 history 路由，所以非静态资源路径必须回退到 index.html，
// 否则刷新 /sites/S01 会 404。
func (s *Server) mountStatic(r chi.Router) {
	dir := s.cfg.WebDir
	if _, err := os.Stat(dir); err != nil {
		r.Get("/", func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprintln(w, "waterlog-v3 api ok; 前端未构建（web/dist 不存在）")
		})
		return
	}
	fs := http.FileServer(http.Dir(dir))
	r.Handle("/*", spaHandler(dir, fs))
}

// spaHandler 把非静态资源路径回退到 index.html。
func spaHandler(dir string, fs http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := dir + r.URL.Path
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			fs.ServeHTTP(w, r)
			return
		}
		http.ServeFile(w, r, dir+"/index.html")
	})
}
