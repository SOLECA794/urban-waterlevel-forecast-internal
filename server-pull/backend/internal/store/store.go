// Package store 数据层：SQLite 打开/迁移/种子 + 全部仓储查询。
// DDL 平移自原 SQLAlchemy 模型；Parquet/DuckDB 时序统一入 observation 表。
package store

import (
	"embed"
	"fmt"
	"os"
	"path/filepath"

	"github.com/jmoiron/sqlx"
	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Store SQLite 数据库句柄。
type Store struct {
	DB *sqlx.DB
}

// Open 打开（或创建）SQLite 数据库并执行迁移。WAL + foreign_keys ON。
func Open(path string) (*Store, error) {
	if dir := filepath.Dir(path); dir != "." && dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("创建数据目录失败: %w", err)
		}
	}
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=foreign_keys(ON)&_pragma=busy_timeout(5000)", path)
	db, err := sqlx.Connect("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("打开 SQLite 失败: %w", err)
	}
	db.SetMaxOpenConns(1) // modernc sqlite 单写者；本系统写入量低
	s := &Store{DB: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) migrate() error {
	entries, err := migrationsFS.ReadDir("migrations")
	if err != nil {
		return err
	}
	for _, e := range entries {
		b, err := migrationsFS.ReadFile("migrations/" + e.Name())
		if err != nil {
			return err
		}
		if _, err := s.DB.Exec(string(b)); err != nil {
			return fmt.Errorf("迁移 %s 失败: %w", e.Name(), err)
		}
	}
	return nil
}

// Close 关闭数据库。
func (s *Store) Close() error { return s.DB.Close() }

// StationRow station 表行。
type StationRow struct {
	StationID       int64   `db:"station_id"`
	StationCode     string  `db:"station_code"`
	StationName     string  `db:"station_name"`
	Location        *string `db:"location"`
	Kind            *string `db:"kind"`
	SourceID        *int64  `db:"source_id"`
	ThresholdBlue   *float64 `db:"threshold_blue"`
	ThresholdYellow *float64 `db:"threshold_yellow"`
	ThresholdOrange *float64 `db:"threshold_orange"`
	ThresholdRed    *float64 `db:"threshold_red"`
	BaseLevel       *float64 `db:"base_level"`
	ResponseK       *float64 `db:"response_k"`
	Longitude       *float64 `db:"longitude"`
	Latitude        *float64 `db:"latitude"`
	Enabled         bool    `db:"enabled"`
	CreateTime      int64   `db:"create_time"`
	UpdateTime      int64   `db:"update_time"`
}

// ModelRow model 表行。
type ModelRow struct {
	ModelID         int64   `db:"model_id"`
	ModelName       string  `db:"model_name"`
	Version         string  `db:"version"`
	ModelType       string  `db:"model_type"`
	AlgorithmConfig *string `db:"algorithm_config"`
	Rmse            *float64 `db:"rmse"`
	Mae             *float64 `db:"mae"`
	ModelFile       string  `db:"model_file"`
	Active          bool    `db:"active"`
	CreateTime      int64   `db:"create_time"`
	UpdateTime      int64   `db:"update_time"`
}

// ForecastRow forecast 表行。
type ForecastRow struct {
	ForecastID    int64   `db:"forecast_id"`
	StationID     int64   `db:"station_id"`
	ModelID       *int64  `db:"model_id"`
	ModelType     string  `db:"model_type"`
	LeadHours     int     `db:"lead_hours"`
	PredictTime   int64   `db:"predict_time"`
	HorizonEndTime int64  `db:"horizon_end_time"`
	PeakLevel     *float64 `db:"peak_level"`
	PeakTime      *int64  `db:"peak_time"`
	Rmse          *float64 `db:"rmse"`
	Mae           *float64 `db:"mae"`
	Degraded      bool    `db:"degraded"`
	Remark        *string `db:"remark"`
	CreateTime    int64   `db:"create_time"`
}

// ForecastPointRow forecast_point 表行。
type ForecastPointRow struct {
	ForecastID   int64    `db:"forecast_id"`
	LeadMinutes  int      `db:"lead_minutes"`
	TargetTime   int64    `db:"target_time"`
	PredLevelRaw float64  `db:"pred_level_raw"`
	Revision     *float64 `db:"revision"`
	PredLevel    float64  `db:"pred_level"`
	LowerBound   *float64 `db:"lower_bound"`
	UpperBound   *float64 `db:"upper_bound"`
	ActualLevel  *float64 `db:"actual_level"`
}

// DecisionRow forecast_decision 表行。
type DecisionRow struct {
	DecisionID    int64   `db:"decision_id"`
	ForecastID    int64   `db:"forecast_id"`
	SelectedModel string  `db:"selected_model"`
	FusionWeights *string `db:"fusion_weights"`
	RevisionAlpha *float64 `db:"revision_alpha"`
	CiScale       *float64 `db:"ci_scale"`
	Degraded      *bool   `db:"degraded"`
	Reason        *string `db:"reason"`
	CreateTime    int64   `db:"create_time"`
}

// AlertRow alert 表行。
type AlertRow struct {
	AlertID              int64    `db:"alert_id"`
	StationID            int64    `db:"station_id"`
	ForecastID           *int64   `db:"forecast_id"`
	Level                string   `db:"level"`
	Reason               *string  `db:"reason"`
	PeakLevel            *float64 `db:"peak_level"`
	PeakTime             *int64   `db:"peak_time"`
	LeadMinutesAdvantage *int     `db:"lead_minutes_advantage"`
	IsReference          bool     `db:"is_reference"`
	LeadHours            *int     `db:"lead_hours"`
	AlertTime            int64    `db:"alert_time"`
	ResolveTime          *int64   `db:"resolve_time"`
	Status               string   `db:"status"`
	FalseReportReason    *string  `db:"false_report_reason"`
	DurationMin          *int     `db:"duration_min"`
	Trend                *float64 `db:"trend"`
}

// AlertLevelRow alert_level_config 表行。
type AlertLevelRow struct {
	Rank                int     `db:"rank"`
	Name                string  `db:"name"`
	LevelKey            string  `db:"level_key"`
	Color               string  `db:"color"`
	WaterLevelThreshold float64 `db:"water_level_threshold"`
	DurationThreshold   int     `db:"duration_threshold"`
	Description         *string `db:"description"`
	Enabled             bool    `db:"enabled"`
}

// LeadConfigRow forecast_lead_config 表行。
type LeadConfigRow struct {
	LeadHours     int     `db:"lead_hours"`
	Enabled       bool    `db:"enabled"`
	DefaultWeight float64 `db:"default_weight"`
	IsReserved    bool    `db:"is_reserved"`
}

// PublishRecordRow publish_record 表行。
type PublishRecordRow struct {
	RecordID    int64  `db:"record_id"`
	AlertID     int64  `db:"alert_id"`
	ChannelID   int64  `db:"channel_id"`
	Content     *string `db:"content"`
	PublishedAt int64  `db:"published_at"`
}

// PublishChannelRow publish_channel 表行。
type PublishChannelRow struct {
	ID       int64   `db:"id"`
	Type     string  `db:"type"`
	Name     string  `db:"name"`
	Enabled  bool    `db:"enabled"`
	Endpoint *string `db:"endpoint"`
	Template *string `db:"template"`
}

// DatasourceConfigRow datasource_config 表行。
type DatasourceConfigRow struct {
	ID                 int64    `db:"id"`
	Type               string   `db:"type"`
	Name               string   `db:"name"`
	Status             string   `db:"status"`
	Endpoint           *string  `db:"endpoint"`
	RefreshIntervalSec int      `db:"refresh_interval_sec"`
	QualitySuccessRate *float64 `db:"quality_success_rate"`
	QualityMissingRate *float64 `db:"quality_missing_rate"`
	QualityAvgLatency  *float64 `db:"quality_avg_latency"`
	SchemaJSON         *string  `db:"schema_json"`
	Enabled            bool     `db:"enabled"`
	LastError          *string  `db:"last_error"`
	UpdatedAt          int64    `db:"updated_at"`
}

// CalibrationRow calibration_record 表行。
type CalibrationRow struct {
	ID          int64   `db:"id"`
	Type        string  `db:"type"`
	Target      *string `db:"target"`
	BeforeJSON  *string `db:"before_json"`
	AfterJSON   *string `db:"after_json"`
	PreviewJSON *string `db:"preview_json"`
	Status      string  `db:"status"`
	ExecutedBy  *string `db:"executed_by"`
	Note        *string `db:"note"`
	CreatedAt   int64   `db:"created_at"`
}

// TaskRow task 表行。
type TaskRow struct {
	TaskID        int64   `db:"task_id"`
	TaskType      string  `db:"task_type"`
	Status        string  `db:"status"`
	RequestJSON   *string `db:"request_json"`
	ResultSummary *string `db:"result_summary"`
	ErrorMessage  *string `db:"error_message"`
	CreateTime    int64   `db:"create_time"`
	FinishTime    *int64  `db:"finish_time"`
}

// ObservationRow observation 表行。
type ObservationRow struct {
	StationID    int64    `db:"station_id"`
	Ts           int64    `db:"ts"`
	Level        *float64 `db:"level"`
	RainObserved *float64 `db:"rain_observed"`
	RainForecast *float64 `db:"rain_forecast"`
}

// InjectedEventRow injected_event 表行。
type InjectedEventRow struct {
	EventID         string   `db:"event_id"`
	StationID       int64    `db:"station_id"`
	Intensity       string   `db:"intensity"`
	IntensityLabel  *string  `db:"intensity_label"`
	PeakMmPerStep   *float64 `db:"peak_mm_per_step"`
	DurationMinutes *int     `db:"duration_minutes"`
	StartTs         int64    `db:"start_ts"`
	EndTs           int64    `db:"end_ts"`
	ShapeJSON       *string  `db:"shape_json"`
	InjectedAt      int64    `db:"injected_at"`
}
