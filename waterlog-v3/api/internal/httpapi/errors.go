package httpapi

import (
	"errors"
	"net/http"

	"waterlog-v3/api/internal/service"
)

// failErr 把业务错误翻译成 HTTP 状态码。
//
// service 层用 service.Error 携带"该回什么码"的意图，这里只做映射；
// 文案一律原样透出——前端按文案做提示（比如「已确认，无需重复确认」）。
func failErr(w http.ResponseWriter, err error) {
	var se *service.Error
	if errors.As(err, &se) {
		switch se.Kind {
		case service.KindBadRequest:
			fail(w, http.StatusBadRequest, se.Msg)
		case service.KindNotFound:
			fail(w, http.StatusNotFound, se.Msg)
		case service.KindConflict:
			fail(w, http.StatusConflict, se.Msg)
		default:
			fail(w, http.StatusInternalServerError, se.Msg)
		}
		return
	}
	fail(w, http.StatusInternalServerError, err.Error())
}
