package service

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"waterlog/backend/internal/config"
	"waterlog/backend/internal/errs"
	"waterlog/backend/internal/store"
)

func setupAlertService(t *testing.T) (*AlertService, *store.Store) {
	t.Helper()
	dir, err := os.MkdirTemp("", "waterlog-alert-test-*")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	st, err := store.Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := st.Seed(time.Now()); err != nil {
		t.Fatal(err)
	}
	bus := NewBus()
	cfg := config.AlertConfig{DedupMinutes: 30, ResolveMinutes: 15}
	return NewAlertService(cfg, st, bus), st
}

func TestConfirmAlertNotFound(t *testing.T) {
	svc, _ := setupAlertService(t)
	_, err := svc.ConfirmAlert(99999)
	if err == nil {
		t.Fatal("expect error for non-existent alert")
	}
	be, ok := err.(*errs.BizError)
	if !ok || be.Code != errs.RESOURCE_NOT_FOUND {
		t.Fatalf("expect RESOURCE_NOT_FOUND, got %v", err)
	}
}

func TestFalseReportTerminalState(t *testing.T) {
	svc, st := setupAlertService(t)
	// 创建一条 resolved 状态的预警
	reason := "test"
	peak := 2.5
	id, err := st.CreateAlert(&store.AlertRow{
		StationID: 1, Level: "yellow", Reason: &reason,
		PeakLevel: &peak, AlertTime: time.Now().Unix(), Status: "resolved",
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = svc.FalseReportAlert(id, "test")
	if err == nil {
		t.Fatal("expect error for resolved alert")
	}
	be, ok := err.(*errs.BizError)
	if !ok || be.Code != errs.PARAM_INVALID {
		t.Fatalf("expect PARAM_INVALID, got %v", err)
	}
}

func TestInvalidTransition(t *testing.T) {
	svc, st := setupAlertService(t)
	// 创建一条 confirmed 状态的预警，再尝试 confirm
	reason := "test"
	peak := 2.5
	id, err := st.CreateAlert(&store.AlertRow{
		StationID: 1, Level: "yellow", Reason: &reason,
		PeakLevel: &peak, AlertTime: time.Now().Unix(), Status: "confirmed",
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = svc.ConfirmAlert(id)
	if err == nil {
		t.Fatal("expect error for duplicate confirm")
	}
	be, ok := err.(*errs.BizError)
	if !ok || be.Code != errs.PARAM_INVALID {
		t.Fatalf("expect PARAM_INVALID, got %v", err)
	}
}
