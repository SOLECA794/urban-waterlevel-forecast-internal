// Package analysis 模板引擎 Provider（默认规则驱动）。
package analysis

import (
	"bytes"
	"context"
	"fmt"
	"strings"
	"text/template"
	"time"
)

// TemplateProvider 基于规则模板生成研判报告
type TemplateProvider struct{}

// NewTemplateProvider 构造模板引擎。
func NewTemplateProvider() *TemplateProvider {
	return &TemplateProvider{}
}

// Name 返回引擎名。
func (p *TemplateProvider) Name() string { return "template" }

// Generate 基于规则模板生成报告。
func (p *TemplateProvider) Generate(ctx context.Context, rc ReportContext) (*ReportResult, error) {
	// 形势研判
	situation := p.buildSituation(rc)

	// 风险等级
	risk := p.assessRisk(rc)

	// 处置建议
	suggestions := p.buildSuggestions(rc, risk)

	// 关注要点
	watchPoints := p.buildWatchPoints(rc, risk)

	// 置信度
	confidence := p.computeConfidence(rc)

	return &ReportResult{
		StationID:   rc.StationID,
		StationCode: rc.StationCode,
		Situation:   situation,
		RiskLevel:   risk,
		Suggestions: suggestions,
		WatchPoints: watchPoints,
		Confidence:  confidence,
		Provider:    p.Name(),
		GeneratedAt: time.Now(),
		RawContext:  &rc,
	}, nil
}

func (p *TemplateProvider) buildSituation(rc ReportContext) string {
	var parts []string
	parts = append(parts, fmt.Sprintf("%s（%s）当前水位%.2fm", rc.StationCode, rc.StationName, rc.CurrentLevel))

	if rc.ForecastPeak > 0 {
		parts = append(parts, fmt.Sprintf("预计未来%d小时内峰值可达%.2fm", rc.LeadHours, rc.ForecastPeak))
	}

	if rc.RainLast6h > 0 {
		parts = append(parts, fmt.Sprintf("过去6小时累计降雨%.1fmm", rc.RainLast6h))
	} else {
		parts = append(parts, "过去6小时无明显降雨")
	}

	switch rc.Trend {
	case "上升":
		parts = append(parts, "水位呈上升趋势，需密切关注")
	case "下降":
		parts = append(parts, "水位呈下降趋势，风险缓解")
	default:
		parts = append(parts, "水位相对平稳")
	}

	if rc.Degraded {
		parts = append(parts, "【注意】当前处于降级预测模式，数据质量可能受限")
	}

	return strings.Join(parts, "；") + "。"
}

func (p *TemplateProvider) assessRisk(rc ReportContext) RiskLevel {
	peak := rc.ForecastPeak
	if peak <= 0 {
		peak = rc.CurrentLevel
	}

	// 按阈值评估
	th := []struct {
		label string
		val   float64
	}{
		{"红", rc.ThresholdRed},
		{"橙", rc.ThresholdOrange},
		{"黄", rc.ThresholdYellow},
		{"蓝", rc.ThresholdBlue},
	}

	maxLevel := ""
	for _, t := range th {
		if t.val > 0 && peak >= t.val {
			maxLevel = t.label
			break
		}
	}

	// 映射到风险等级
	switch maxLevel {
	case "红":
		return RiskCritical
	case "橙":
		return RiskHigh
	case "黄":
		return RiskMedium
	case "蓝":
		return RiskLow
	default:
		return RiskLow
	}
}

func (p *TemplateProvider) buildSuggestions(rc ReportContext, risk RiskLevel) []string {
	var s []string
	s = append(s, fmt.Sprintf("持续监测%s水位变化，每15分钟巡查一次", rc.StationCode))

	switch risk {
	case RiskCritical:
		s = append(s, "立即启动应急预案，组织人员疏散低洼区域")
		s = append(s, "关闭该路段交通，设置警戒线与警示标识")
		s = append(s, "通知排水泵站满负荷运行，打开应急泄洪通道")
	case RiskHigh:
		s = append(s, "加强巡查频次，准备应急排水设备")
		s = append(s, "通知相关部门进入待命状态")
		s = append(s, "视情况提前封闭易涝路段")
	case RiskMedium:
		s = append(s, "关注降雨强度和持续时间，做好预排准备")
		s = append(s, "检查排水口是否畅通，清理可能的堵塞物")
	default:
		s = append(s, "维持常规监测，记录水位变化趋势")
	}

	if rc.Degraded {
		s = append(s, "【数据降级】建议人工复核现场实况，补充观测数据")
	}
	return s
}

func (p *TemplateProvider) buildWatchPoints(rc ReportContext, risk RiskLevel) []string {
	var w []string
	w = append(w, fmt.Sprintf("%s未来1-3小时水位涨幅是否超过%.2fm", rc.StationCode, rc.ThresholdBlue))
	if rc.RainLast6h > 10 {
		w = append(w, "后续降雨是否持续或增强")
	}
	if risk == RiskHigh || risk == RiskCritical {
		w = append(w, "周边排水泵站运行状态与抽排能力")
		w = append(w, "低洼区域人员与车辆滞留情况")
	}
	if rc.Degraded {
		w = append(w, "数据源恢复情况与预测精度回退验证")
	}
	if len(w) < 2 {
		w = append(w, "退水速度与基流恢复情况")
	}
	return w
}

func (p *TemplateProvider) computeConfidence(rc ReportContext) float64 {
	conf := 0.85
	if rc.Degraded {
		conf -= 0.25
	}
	if rc.RainLast6h > 20 {
		conf -= 0.1
	}
	if rc.LeadHours > 12 {
		conf -= 0.1
	}
	if conf < 0.3 {
		conf = 0.3
	}
	return conf
}

// RenderMarkdown 将报告渲染为 Markdown 文本（供人工阅读或导出）。
func RenderMarkdown(r *ReportResult) string {
	const tpl = `# {{.StationCode}} 智能研判报告
> 生成时间：{{.GeneratedAt.Format "2006-01-02 15:04"}} | 引擎：{{.Provider}} | 置信度：{{printf "%.0f" .Confidence}}

## 一、形势研判
{{.Situation}}

## 二、风险等级
{{.RiskLevel}}

## 三、处置建议
{{range .Suggestions}}- {{.}}
{{end}}

## 四、关注要点
{{range .WatchPoints}}- {{.}}
{{end}}
`
	t, err := template.New("report").Parse(tpl)
	if err != nil {
		return ""
	}
	var buf bytes.Buffer
	_ = t.Execute(&buf, r)
	return buf.String()
}
