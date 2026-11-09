package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
)

// decodeJSON 读请求体 JSON。
//
// 空 body 也算合法（很多 POST 不需要参数，比如 /api/alerts/{id}/ack）：
// 这里把 io.EOF 当成"没传"，而不是 400。否则前端要为一个纯动作接口
// 专门塞一个 "{}" 进去，那种约定迟早会被某处忘掉。
func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(dst)
	if err == nil || err == io.EOF {
		return true
	}
	fail(w, http.StatusBadRequest, "body 需为 JSON："+err.Error())
	return false
}
