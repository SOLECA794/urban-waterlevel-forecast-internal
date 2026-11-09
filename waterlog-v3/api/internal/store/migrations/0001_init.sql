-- 0001_init.sql
-- v3 本地存储的初始表结构。与改造前 store.go 里的 schema 常量逐字一致，
-- 只做了拆分（一条语句一段），执行方式仍是整文件 Exec（SQLite 支持多语句）。
--
-- 分工：Python 负责算，Go 负责存与发。Go 这边只存三类东西——
--   1. telemetry：站点遥测时序（前端曲线、一张图、评估都用它）
--   2. forecast_snapshot：每次预测的完整快照（前端详情页、预测 vs 实际对比）
--   3. warning_event：预警事件的生命周期（这是"结果应用"要落到的东西）
-- 预测值本身不进 telemetry，避免"预测被当成实测"这类最难查的错。

CREATE TABLE IF NOT EXISTS telemetry (
  ts INTEGER NOT NULL,
  site_id TEXT NOT NULL,
  level REAL NOT NULL,
  rain REAL NOT NULL,
  quality INTEGER NOT NULL,
  rain_fc_1h REAL NOT NULL DEFAULT 0,
  rain_fc_3h REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (ts, site_id)
);
CREATE INDEX IF NOT EXISTS idx_tel_site_ts ON telemetry(site_id, ts);

CREATE TABLE IF NOT EXISTS forecast_snapshot (
  issued_at INTEGER PRIMARY KEY,
  model_version TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS warning_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  level TEXT NOT NULL,
  score REAL NOT NULL,
  peak_value REAL NOT NULL,
  peak_at_min INTEGER,
  duration_min INTEGER NOT NULL,
  slope_mh REAL NOT NULL,
  reason TEXT NOT NULL,
  state TEXT NOT NULL,
  disposition TEXT NOT NULL DEFAULT 'open',
  assignee TEXT,
  raised_at INTEGER NOT NULL,
  acked_at INTEGER,
  cleared_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_warn_open ON warning_event(site_id, state);

CREATE TABLE IF NOT EXISTS alert_note (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  author TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_note_alert ON alert_note(alert_id, id);

CREATE TABLE IF NOT EXISTS decision (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  site_id TEXT NOT NULL,
  should_forecast INTEGER NOT NULL,
  model TEXT,
  gain REAL,
  reason TEXT,
  signals TEXT
);
CREATE INDEX IF NOT EXISTS idx_dec_ts ON decision(ts);
