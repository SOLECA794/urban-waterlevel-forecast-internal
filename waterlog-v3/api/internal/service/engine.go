package service

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"waterlog-v3/api/internal/domain"
)

// Engine 是 Python 引擎的 HTTP 客户端。
//
// Go 侧不做任何计算：规则、模型版本、重训、演练注入这些请求全部原样转发，
// 状态码与响应体也原样回传——前端就是照着引擎的响应写的。
type Engine struct {
	baseURL string
}

// NewEngine 构造引擎客户端。
func NewEngine(baseURL string) *Engine { return &Engine{baseURL: baseURL} }

// URL 返回引擎基地址（health 响应里会原样带出去）。
func (e *Engine) URL() string { return e.baseURL }

// ProxyResult 是转发后的原始响应：状态码 + 未读取的响应体，由调用方决定怎么写给前端。
type ProxyResult struct {
	Status int
	Body   io.ReadCloser
}

// Close 关闭底层响应体。
func (r *ProxyResult) Close() {
	if r != nil && r.Body != nil {
		_ = r.Body.Close()
	}
}

// FetchSites 从引擎拉站点清单（3 秒超时）。失败由上层回落到内置副本。
func (e *Engine) FetchSites(ctx context.Context) ([]domain.SiteMeta, error) {
	type resp struct {
		Sites []struct {
			ID          string    `json:"id"`
			Name        string    `json:"name"`
			District    string    `json:"district"`
			Lon         float64   `json:"lon"`
			Lat         float64   `json:"lat"`
			BaseLevel   float64   `json:"base_level"`
			Thresholds  []float64 `json:"thresholds"`
			Kind        string    `json:"kind"`
			CatchmentHa float64   `json:"catchment_ha"`
			PondHa      float64   `json:"pond_ha"`
			Impervious  float64   `json:"impervious"`
			DrainageMmH float64   `json:"drainage_mm_h"`
		} `json:"sites"`
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, e.baseURL+"/sites", nil)
	if err != nil {
		return nil, err
	}
	r, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer r.Body.Close()
	if r.StatusCode != http.StatusOK {
		return nil, nil
	}
	var body resp
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		return nil, err
	}
	out := make([]domain.SiteMeta, 0, len(body.Sites))
	for _, x := range body.Sites {
		out = append(out, domain.SiteMeta{
			SiteID: x.ID, Name: x.Name, District: x.District, Lon: x.Lon, Lat: x.Lat,
			BaseLevel: x.BaseLevel, Thresholds: x.Thresholds, Kind: x.Kind,
			CatchmentHa: x.CatchmentHa, PondHa: x.PondHa, Impervious: x.Impervious,
			Drainage: x.DrainageMmH,
		})
	}
	return out, nil
}

// Health 探测引擎健康状态：返回 (引擎健康体, 是否可达)。
func (e *Engine) Health() (map[string]any, bool) {
	resp, err := http.Get(e.baseURL + "/health")
	if err != nil {
		return nil, false
	}
	defer resp.Body.Close()
	var eng map[string]any
	if json.NewDecoder(resp.Body).Decode(&eng) != nil {
		return nil, false
	}
	return eng, true
}

// Get 把 GET 请求（含 query）原样转发给引擎。
func (e *Engine) Get(path, rawQuery string) (*ProxyResult, error) {
	url := e.baseURL + path
	if rawQuery != "" {
		url += "?" + rawQuery
	}
	resp, err := http.Get(url)
	if err != nil {
		return nil, err
	}
	return &ProxyResult{Status: resp.StatusCode, Body: resp.Body}, nil
}

// PutJSON 把 PUT 请求体原样转发给引擎。
func (e *Engine) PutJSON(path string, body []byte) (*ProxyResult, error) {
	req, err := http.NewRequest(http.MethodPut, e.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	return &ProxyResult{Status: resp.StatusCode, Body: resp.Body}, nil
}

// PostJSON 把 POST 请求（body 可选，query 透传）原样转发给引擎。
func (e *Engine) PostJSON(path, rawQuery string, body []byte) (*ProxyResult, error) {
	url := e.baseURL + path
	if rawQuery != "" {
		url += "?" + rawQuery
	}
	var r io.Reader
	if len(body) > 0 {
		r = bytes.NewReader(body)
	}
	req, err := http.NewRequest(http.MethodPost, url, r)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	return &ProxyResult{Status: resp.StatusCode, Body: resp.Body}, nil
}

// PostEmpty 发一个无 body 的 POST（演练注入、重训这类"命令型"请求）。
func (e *Engine) PostEmpty(path, rawQuery string) (*ProxyResult, error) {
	url := e.baseURL + path
	if rawQuery != "" {
		url += "?" + rawQuery
	}
	resp, err := http.Post(url, "application/json", nil)
	if err != nil {
		return nil, err
	}
	return &ProxyResult{Status: resp.StatusCode, Body: resp.Body}, nil
}
