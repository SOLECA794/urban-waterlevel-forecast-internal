// Open-Meteo 真实气象预报客户端（免 key）。
// 移植自 app/infrastructure/datasource/openmeteo_client.py（net/http + 30min 缓存 + 失败降级）。
package datasource

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// 杭州市中心默认坐标（站点无独立经纬度时使用）。
const (
	DefaultLat = 30.25
	DefaultLon = 120.17
)

type openmeteoEntry struct {
	ts     time.Time
	rainMmH float64
}

// OpenMeteoClient Open-Meteo 降雨预报客户端（带缓存）。
type OpenMeteoClient struct {
	mu      sync.Mutex
	client  *http.Client
	cacheKey int64
	hourly  []openmeteoEntry
	fetchOK bool
	lastErr string
}

// NewOpenMeteoClient 构造客户端。
func NewOpenMeteoClient() *OpenMeteoClient {
	return &OpenMeteoClient{client: &http.Client{Timeout: 8 * time.Second}}
}

func (c *OpenMeteoClient) fetchHourly(lat, lon float64) ([]openmeteoEntry, error) {
	q := url.Values{}
	q.Set("latitude", fmt.Sprintf("%f", lat))
	q.Set("longitude", fmt.Sprintf("%f", lon))
	q.Set("hourly", "precipitation")
	q.Set("forecast_days", "2")
	q.Set("timezone", "Asia/Shanghai")
	req, err := http.NewRequest(http.MethodGet,
		"https://api.open-meteo.com/v1/forecast?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "waterlevel-forecast/1.0")
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("open-meteo HTTP %d", resp.StatusCode)
	}
	var data struct {
		Hourly struct {
			Time []string  `json:"time"`
			Precipitation []float64 `json:"precipitation"`
		} `json:"hourly"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return nil, err
	}
	out := make([]openmeteoEntry, 0, len(data.Hourly.Time))
	for i, ts := range data.Hourly.Time {
		t, err := time.ParseInLocation("2006-01-02T15:04", ts, time.Local)
		if err != nil {
			continue
		}
		rain := 0.0
		if i < len(data.Hourly.Precipitation) && !math.IsNaN(data.Hourly.Precipitation[i]) {
			rain = data.Hourly.Precipitation[i]
		}
		out = append(out, openmeteoEntry{ts: t, rainMmH: rain})
	}
	return out, nil
}

// GetRealRainForecast 返回 [tIssue, tIssue+hours] 的 5min 降雨预报（mm/step）。
// 真数据失败返回 nil（调用方 fallback 到模拟）。lat/lon 为站点坐标。
func (c *OpenMeteoClient) GetRealRainForecast(tIssue time.Time, hours, stepMinutes int,
	lat, lon float64) ([]forecastRain, error) {
	nowKey := time.Now().Unix() / 1800 // 每 30 分钟一个缓存 key
	c.mu.Lock()
	if c.cacheKey != nowKey || !c.fetchOK {
		c.mu.Unlock()
		hourly, err := c.fetchHourly(lat, lon)
		c.mu.Lock()
		if err != nil {
			c.lastErr = err.Error()
			c.mu.Unlock()
			return nil, err
		}
		c.cacheKey, c.hourly, c.fetchOK = nowKey, hourly, true
		c.lastErr = ""
	}
	hourly := c.hourly
	errStr := c.lastErr
	c.mu.Unlock()
	_ = errStr // 最近一次抓取错误（仅诊断用）

	n := hours * 60 / stepMinutes
	out := make([]forecastRain, 0, n)
	for k := 0; k < n; k++ {
		ts := tIssue.Add(time.Duration(k*stepMinutes) * time.Minute)
		floorH := ts.Truncate(time.Hour)
		mmh := 0.0
		found := false
		for _, e := range hourly {
			if e.ts.Equal(floorH) {
				mmh = e.rainMmH
				found = true
				break
			}
		}
		_ = found
		out = append(out, forecastRain{
			Ts:           ts,
			RainForecast: roundTo(mmh*float64(stepMinutes)/60.0, 3),
		})
	}
	return out, nil
}

// Status 供健康检查：缓存是否可用与最近错误。
func (c *OpenMeteoClient) Status() (ok bool, lastErr string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.fetchOK, c.lastErr
}

// forecastRain 降雨预报点（包内通用结构）。
type forecastRain struct {
	Ts           time.Time
	RainForecast float64
}

// RainPoint 降雨预报点（导出版，供 service / httpapi 使用）。
type RainPoint = forecastRain

func roundTo(v float64, n int) float64 {
	p := math.Pow(10, float64(n))
	return math.Round(v*p) / p
}
