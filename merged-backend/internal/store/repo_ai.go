// Package store P1 AI 能力仓储方法。
package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

// AttributionRow forecast_attribution 表行。
type AttributionRow struct {
	AttributionID  int64   `db:"attribution_id"`
	ForecastID     int64   `db:"forecast_id"`
	StationID      int64   `db:"station_id"`
	StationCode    string  `db:"station_code"`
	LeadHours      int     `db:"lead_hours"`
	BaseLevel      float64 `db:"base_level"`
	PredictedLevel float64 `db:"predicted_level"`
	PeakTime       int64   `db:"peak_time"`
	FactorsJSON    string  `db:"factors_json"`
	ModelInfoJSON  string  `db:"model_info_json"`
	Summary        string  `db:"summary"`
	CreateTime     int64   `db:"create_time"`
}

// AnalysisReportRow analysis_report 表行。
type AnalysisReportRow struct {
	ReportID        int64    `db:"report_id"`
	StationID       int64    `db:"station_id"`
	StationCode     string   `db:"station_code"`
	AlertID         *int64   `db:"alert_id"`
	ForecastID      *int64   `db:"forecast_id"`
	Situation       string   `db:"situation"`
	RiskLevel       string   `db:"risk_level"`
	SuggestionsJSON string   `db:"suggestions_json"`
	WatchPointsJSON string   `db:"watch_points_json"`
	Confidence      float64  `db:"confidence"`
	Provider        string   `db:"provider"`
	GeneratedAt     int64    `db:"generated_at"`
	CreateTime      int64    `db:"create_time"`
}

// SaveAttribution 保存或更新归因结果（入参为平铺字段，避免循环依赖）。
func (s *Store) SaveAttribution(forecastID, stationID int64, stationCode string, leadHours int,
	baseLevel, predictedLevel float64, peakTime int64,
	factorsJSON, modelInfoJSON, summary string) error {
	_, err := s.DB.Exec(`
		INSERT INTO forecast_attribution
		(forecast_id, station_id, station_code, lead_hours, base_level, predicted_level, peak_time,
		 factors_json, model_info_json, summary, create_time)
		VALUES (?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(forecast_id) DO UPDATE SET
			station_id=excluded.station_id,
			station_code=excluded.station_code,
			lead_hours=excluded.lead_hours,
			base_level=excluded.base_level,
			predicted_level=excluded.predicted_level,
			peak_time=excluded.peak_time,
			factors_json=excluded.factors_json,
			model_info_json=excluded.model_info_json,
			summary=excluded.summary,
			create_time=excluded.create_time`,
		forecastID, stationID, stationCode, leadHours,
		baseLevel, predictedLevel, peakTime,
		factorsJSON, modelInfoJSON, summary, time.Now().Unix())
	return err
}

// GetAttributionByForecast 按 forecast_id 查询归因结果。
func (s *Store) GetAttributionByForecast(forecastID int64) (*AttributionRow, error) {
	var r AttributionRow
	err := s.DB.Get(&r, `SELECT * FROM forecast_attribution WHERE forecast_id=?`, forecastID)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return &r, err
}

// SaveAnalysisReport 保存研判报告（入参为平铺字段，避免循环依赖）。
func (s *Store) SaveAnalysisReport(stationID int64, stationCode string, alertID, forecastID *int64,
	situation, riskLevel string, suggestions, watchPoints []string,
	confidence float64, provider string, generatedAt int64) (int64, error) {
	suggestionsJSON, _ := json.Marshal(suggestions)
	watchPointsJSON, _ := json.Marshal(watchPoints)
	res, err := s.DB.Exec(`
		INSERT INTO analysis_report
		(station_id, station_code, alert_id, forecast_id, situation, risk_level,
		 suggestions_json, watch_points_json, confidence, provider, generated_at, create_time)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
		stationID, stationCode, alertID, forecastID, situation, riskLevel,
		string(suggestionsJSON), string(watchPointsJSON), confidence, provider,
		generatedAt, time.Now().Unix())
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// GetAnalysisReport 按 ID 查询研判报告。
func (s *Store) GetAnalysisReport(id int64) (*AnalysisReportRow, error) {
	var r AnalysisReportRow
	err := s.DB.Get(&r, `SELECT * FROM analysis_report WHERE report_id=?`, id)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return &r, err
}

// ListAnalysisReports 分页查询研判报告。
func (s *Store) ListAnalysisReports(stationID *int64, page, pageSize int) ([]AnalysisReportRow, int, error) {
	where := "1=1"
	args := []any{}
	if stationID != nil {
		where += " AND station_id=?"
		args = append(args, *stationID)
	}

	var total int
	countQ := fmt.Sprintf("SELECT COUNT(*) FROM analysis_report WHERE %s", where)
	if err := s.DB.Get(&total, countQ, args...); err != nil {
		return nil, 0, err
	}

	q := fmt.Sprintf(`SELECT * FROM analysis_report WHERE %s ORDER BY generated_at DESC LIMIT ? OFFSET ?`, where)
	args = append(args, pageSize, (page-1)*pageSize)

	var rows []AnalysisReportRow
	if err := s.DB.Select(&rows, q, args...); err != nil {
		return nil, 0, err
	}
	return rows, total, nil
}

// LatestAnalysisReportForStation 查询某站点最新报告。
func (s *Store) LatestAnalysisReportForStation(stationID int64) (*AnalysisReportRow, error) {
	var r AnalysisReportRow
	err := s.DB.Get(&r, `SELECT * FROM analysis_report WHERE station_id=? ORDER BY generated_at DESC LIMIT 1`, stationID)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return &r, err
}
