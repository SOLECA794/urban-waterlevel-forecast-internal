-- 0002_p1_ai_features.sql
-- P1 AI 能力：预测归因解释 + 智能研判助手

-- 预测归因结果缓存表
CREATE TABLE IF NOT EXISTS forecast_attribution (
    attribution_id INTEGER PRIMARY KEY AUTOINCREMENT,
    forecast_id    INTEGER NOT NULL,
    station_id     INTEGER NOT NULL,
    station_code   TEXT NOT NULL,
    lead_hours     INTEGER NOT NULL,
    base_level     REAL NOT NULL,
    predicted_level REAL NOT NULL,
    peak_time      INTEGER NOT NULL,
    factors_json   TEXT NOT NULL,
    model_info_json TEXT NOT NULL,
    summary        TEXT NOT NULL,
    create_time    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    UNIQUE(forecast_id)
);

CREATE INDEX IF NOT EXISTS idx_attr_forecast ON forecast_attribution(forecast_id);
CREATE INDEX IF NOT EXISTS idx_attr_station  ON forecast_attribution(station_id);

-- 智能研判报告表
CREATE TABLE IF NOT EXISTS analysis_report (
    report_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id     INTEGER NOT NULL,
    station_code   TEXT NOT NULL,
    alert_id       INTEGER,
    forecast_id    INTEGER,
    situation      TEXT NOT NULL,
    risk_level     TEXT NOT NULL,
    suggestions_json TEXT NOT NULL,
    watch_points_json TEXT NOT NULL,
    confidence     REAL NOT NULL DEFAULT 0.8,
    provider       TEXT NOT NULL DEFAULT 'template',
    generated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    create_time    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_arpt_station ON analysis_report(station_id);
CREATE INDEX IF NOT EXISTS idx_arpt_alert   ON analysis_report(alert_id);
CREATE INDEX IF NOT EXISTS idx_arpt_forecast ON analysis_report(forecast_id);
CREATE INDEX IF NOT EXISTS idx_arpt_generated ON analysis_report(generated_at);
