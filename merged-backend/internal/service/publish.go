// 预警渠道发布服务（FR-5）：渠道配置 + 发布 + publish_record 落库。
package service

import (
	"fmt"
	"strings"
	"time"

	"waterlog/backend/internal/errs"
	"waterlog/backend/internal/store"
)

// PublishService 发布服务。
type PublishService struct {
	store *store.Store
	bus   *Bus
}

// NewPublishService 构造。
func NewPublishService(st *store.Store, bus *Bus) *PublishService {
	return &PublishService{store: st, bus: bus}
}

var channelCode = map[string]string{
	"inapp_msg": "IN_APP", "infoscreen": "INFO_SCREEN", "sms": "SMS",
}

// PublishAlert 向指定渠道发布预警：渲染模板 → 写 publish_record → 预警置 published。
// channels 为渠道 type 列表（inapp_msg/infoscreen/sms）；空 = 全部启用渠道。
func (p *PublishService) PublishAlert(alertID int64, channels []string, operator string) ([]map[string]any, *errs.BizError) {
	alert, err := p.store.GetAlert(alertID)
	if err != nil {
		return nil, errs.New(errs.RESOURCE_NOT_FOUND, "预警不存在（RESOURCE_NOT_FOUND）")
	}
	if alert.Status == "resolved" || alert.Status == "false_report" {
		return nil, errs.New(errs.PARAM_INVALID, "预警已终结，不可发布（PARAM_INVALID）")
	}
	station, err := p.store.GetStation(alert.StationID)
	if err != nil {
		return nil, errs.New(errs.RESOURCE_NOT_FOUND, "监测点不存在（RESOURCE_NOT_FOUND）")
	}
	all, err := p.store.PublishChannels()
	if err != nil {
		return nil, errs.New(errs.DATABASE_ERROR, "渠道读取失败（DATABASE_ERROR）")
	}
	want := map[string]bool{}
	if len(channels) > 0 {
		for _, c := range channels {
			want[c] = true
		}
	}
	now := time.Now()
	records := []map[string]any{}
	published := false
	for _, ch := range all {
		if len(want) > 0 && !want[ch.Type] {
			continue
		}
		if !ch.Enabled {
			continue
		}
		status := "simulated"
		if ch.Type == "sms" {
			status = "placeholder" // v1 短信只做记录型，不真实对接运营商
		}
		content := p.renderTemplate(ch.Template, alert, station)
		rec, err := p.store.AddPublishRecord(&store.PublishRecordRow{
			AlertID: alertID, ChannelID: ch.ID, Content: &content, PublishedAt: now.Unix(),
		})
		if err != nil {
			continue
		}
		published = true
		records = append(records, map[string]any{
			"recordId":    fmt.Sprintf("P-%06d", rec),
			"alertId":     alertID,
			"stationName": station.StationName,
			"level":       alert.Level,
			"channel":     ch.Name,
			"channelCode": channelCode[ch.Type],
			"status":      status,
			"detail":      content,
			"publishTime": now.Format(time.RFC3339),
		})
	}
	if published {
		if err := p.store.UpdateAlert(alertID, map[string]any{"status": "published"}); err == nil {
			p.bus.Publish("alert.published", map[string]any{"alertId": alertID, "records": len(records)})
		}
	}
	return records, nil
}

// renderTemplate 模板渲染：{station}/{stationName}/{level}/{levelName}/{reason}/{peak} 占位替换；空模板用默认文案。
func (p *PublishService) renderTemplate(tpl *string, alert *store.AlertRow, station *store.StationRow) string {
	s := "{station} 发布 {level} 预警：{reason}"
	if tpl != nil && *tpl != "" {
		s = *tpl
	}
	r := alert.Reason
	if r == nil {
		r = ptrStr("")
	}
	peak := ""
	if alert.PeakLevel != nil {
		peak = fmt.Sprintf("%.2f", *alert.PeakLevel)
	}
	repl := func(src string) string {
		out := ""
		i := 0
		for i < len(src) {
			if src[i] == '{' {
				j := i + 1
				for j < len(src) && src[j] != '}' {
					j++
				}
				if j < len(src) {
					key := src[i+1 : j]
					switch key {
					case "station", "stationName":
						out += station.StationName
					case "levelName":
						out += p.levelNameOf(alert.Level)
					case "peak", "peakLevel":
						out += peak
					case "level":
						out += alert.Level
					case "levelKey":
						out += alert.Level
					case "reason":
						out += *r
					default:
						out += src[i : j+1]
					}
					i = j + 1
					continue
				}
			}
			// 找到下一个 '{' 或字符串末尾，整体追加（保护 UTF-8 多字节字符）
			j := i + 1
			for j < len(src) && src[j] != '{' {
				j++
			}
			out += src[i:j]
			i = j
		}
		return out
	}

	return repl(s)
}

// isGarbled 检测字符串是否为 UTF-8 双重编码导致的乱码。
func isGarbled(s string) bool {
	// UTF-8 双重编码的典型特征：原始 UTF-8 字节被逐字节再编码，
	// 中文字符会产生以 0xC3 / 0xC2 开头的西欧字符序列（如 Ã©Â¢）
	return strings.Contains(s, "\u00C3") || strings.Contains(s, "\u00C2")
}

// FixGarbledRecords 检测并修复已入库的乱码发布记录。返回修复条数。
func (p *PublishService) FixGarbledRecords() (int, error) {
	rows, _, err := p.store.ListPublishRecords(nil, 1, 100000)
	if err != nil {
		return 0, err
	}
	channels, err := p.store.PublishChannels()
	if err != nil {
		return 0, err
	}
	fixed := 0
	for _, r := range rows {
		if r.Content == nil || !isGarbled(*r.Content) {
			continue
		}
		alert, err := p.store.GetAlert(r.AlertID)
		if err != nil {
			continue
		}
		station, err := p.store.GetStation(alert.StationID)
		if err != nil {
			continue
		}
		var tpl *string
		for _, ch := range channels {
			if ch.ID == r.ChannelID {
				tpl = ch.Template
				break
			}
		}
		newContent := p.renderTemplate(tpl, alert, station)
		if err := p.store.UpdatePublishRecordContent(r.RecordID, newContent); err == nil {
			fixed++
		}
	}
	return fixed, nil
}

// levelNameOf 查等级名。
func (p *PublishService) levelNameOf(levelKey string) string {
	if levels, err := p.store.AlertLevels(); err == nil {
		for _, lv := range levels {
			if lv.LevelKey == levelKey {
				return lv.Name
			}
		}
	}
	return levelKey
}

// ListRecords 发布历史（含站点/等级信息富化）。
func (p *PublishService) ListRecords(alertID *int64, page, pageSize int) (int, []map[string]any, error) {
	rows, total, err := p.store.ListPublishRecords(alertID, page, pageSize)
	if err != nil {
		return 0, nil, err
	}
	out := make([]map[string]any, 0, len(rows))
	for _, r := range rows {
		alert, err := p.store.GetAlert(r.AlertID)
		if err != nil {
			continue
		}
		station, _ := p.store.GetStation(alert.StationID)
		chName, chType := "", ""
		if chs, err := p.store.PublishChannels(); err == nil {
			for _, c := range chs {
				if c.ID == r.ChannelID {
					chName, chType = c.Name, c.Type
					break
				}
			}
		}
		stationName := ""
		if station != nil {
			stationName = station.StationName
		}
		content := ""
		if r.Content != nil {
			content = *r.Content
		}
		status := "simulated"
		if chType == "sms" {
			status = "placeholder"
		}
		out = append(out, map[string]any{
			"recordId":    fmt.Sprintf("P-%06d", r.RecordID),
			"alertId":     r.AlertID, "stationName": stationName, "level": alert.Level,
			"channel": chName, "channelCode": channelCode[chType], "status": status,
			"detail": content, "publishTime": time.Unix(r.PublishedAt, 0).Format(time.RFC3339),
		})
	}
	return total, out, nil
}
