package service

import (
	"testing"

	"waterlog/backend/internal/store"
)

func TestRenderTemplateUTF8(t *testing.T) {
	p := &PublishService{}
	alert := &store.AlertRow{
		Level:   "yellow",
		Reason:  ptrStr("测试原因"),
	}
	station := &store.StationRow{
		StationName: "测试站点",
	}
	// 模板含中文，不含 levelName（避免依赖 store）
	tpl := "【防汛】{stationName}预警，峰值{peakLevel}m，原因：{reason}"
	got := p.renderTemplate(&tpl, alert, station)
	want := "【防汛】测试站点预警，峰值m，原因：测试原因"
	if got != want {
		t.Fatalf("renderTemplate = %q, want %q", got, want)
	}
	// 额外验证：模板字面量中的中文不被破坏
	tpl2 := "预警发布"
	got2 := p.renderTemplate(&tpl2, alert, station)
	if got2 != "预警发布" {
		t.Fatalf("纯中文模板被破坏：got %q", got2)
	}
}

func TestIsGarbled(t *testing.T) {
	// 正常中文
	if isGarbled("正常中文") {
		t.Fatal("正常中文不应被判定为乱码")
	}
	// UTF-8 双重编码典型特征（Ã© = 0xC3 0xA9）
	if !isGarbled("Ã©Â¢Â") {
		t.Fatal("应识别 UTF-8 双重编码乱码")
	}
}


