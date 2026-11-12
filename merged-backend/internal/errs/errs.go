// Package errs 业务错误码与业务异常，与原实现 app/core/errors.py 完全对齐。
//
// 约定：HTTP 状态码表达协议层结果；业务 code 表达数据源/预测/模型等应用状态。
// 前端禁止仅凭 HTTP 200 判定业务成功。
package errs

import "fmt"

// Code 业务错误码（与原 ErrorCode 类逐项对齐）。
type Code int

const (
	OK                    Code = 0
	SOURCE_NOT_CONNECTED  Code = 1001
	SOURCE_STREAM_ERROR   Code = 1002
	STATION_STATE_INVALID Code = 1101
	STATION_NOT_FOUND     Code = 1102
	MODEL_NOT_READY       Code = 1201
	MODEL_INPUT_MISMATCH  Code = 1202
	DATA_NOT_ENOUGH       Code = 1301
	DATABASE_ERROR        Code = 1401
	RESOURCE_NOT_FOUND    Code = 1404
	TOOL_NOT_FOUND        Code = 1601
	TOOL_CONFIRM_REQUIRED Code = 1602
	PARAM_INVALID         Code = 400
	INTERNAL_ERROR        Code = 500
)

var descriptions = map[Code]string{
	OK:                    "OK",
	SOURCE_NOT_CONNECTED:  "SOURCE_NOT_CONNECTED",
	SOURCE_STREAM_ERROR:   "SOURCE_STREAM_ERROR",
	STATION_STATE_INVALID: "STATION_STATE_INVALID",
	STATION_NOT_FOUND:     "STATION_NOT_FOUND",
	MODEL_NOT_READY:       "MODEL_NOT_READY",
	MODEL_INPUT_MISMATCH:  "MODEL_INPUT_MISMATCH",
	DATA_NOT_ENOUGH:       "DATA_NOT_ENOUGH",
	DATABASE_ERROR:        "DATABASE_ERROR",
	RESOURCE_NOT_FOUND:    "RESOURCE_NOT_FOUND",
	TOOL_NOT_FOUND:        "TOOL_NOT_FOUND",
	TOOL_CONFIRM_REQUIRED: "TOOL_CONFIRM_REQUIRED",
	PARAM_INVALID:         "PARAM_INVALID",
	INTERNAL_ERROR:        "INTERNAL_ERROR",
}

// Name 返回错误码的符号名。
func (c Code) Name() string {
	if n, ok := descriptions[c]; ok {
		return n
	}
	return fmt.Sprintf("CODE_%d", int(c))
}

// BizError 业务异常：handler 层捕获后输出统一 {code, message, data}。
type BizError struct {
	Code       Code
	Message    string
	Data       any
	HTTPStatus int
}

func (e *BizError) Error() string { return e.Message }

// New 构造业务异常（HTTP 200 + 业务 code 模式，与原实现一致）。
func New(code Code, message string) *BizError {
	return &BizError{Code: code, Message: message, HTTPStatus: 200}
}

// NewWithData 构造带数据的业务异常。
func NewWithData(code Code, message string, data any) *BizError {
	return &BizError{Code: code, Message: message, Data: data, HTTPStatus: 200}
}
