-- 城市内涝水位预测系统 · Go 版 SQLite 初始化 DDL（0001_init）
-- 原则：DDL 平移自原 SQLAlchemy 模型（13 张业务表）+ 架构文档第四节新增/改造表。
-- 兼容性：仅用 INTEGER/TEXT/REAL（PostgreSQL 兼容），时间戳统一为 INTEGER Unix 秒。

-- ============ 原有表（DDL 平移） ============

CREATE TABLE IF NOT EXISTS source (
    source_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    source_code  TEXT NOT NULL UNIQUE,
    source_name  TEXT NOT NULL,
    type         TEXT NOT NULL DEFAULT 'simulated',
    status       TEXT NOT NULL DEFAULT 'DISCONNECTED',
    config_json  TEXT,
    last_error   TEXT,
    create_time  INTEGER NOT NULL,
    update_time  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS station (
    station_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    station_code     TEXT NOT NULL UNIQUE,
    station_name     TEXT NOT NULL,
    location         TEXT,
    kind             TEXT,
    source_id        INTEGER,
    threshold_blue   REAL,
    threshold_yellow REAL,
    threshold_orange REAL,
    threshold_red    REAL,
    base_level       REAL,
    response_k       REAL,
    longitude        REAL,
    latitude         REAL,
    enabled          INTEGER NOT NULL DEFAULT 1,
    create_time      INTEGER NOT NULL,
    update_time      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS forecast (
    forecast_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id       INTEGER NOT NULL,
    model_id         INTEGER,
    model_type       TEXT NOT NULL DEFAULT '',
    lead_hours       INTEGER NOT NULL,
    predict_time     INTEGER NOT NULL,
    horizon_end_time INTEGER NOT NULL,
    peak_level       REAL,
    peak_time        INTEGER,
    rmse             REAL,
    mae              REAL,
    degraded         INTEGER NOT NULL DEFAULT 0,
    remark           TEXT,
    create_time      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_forecast_station ON forecast(station_id, forecast_id DESC);

CREATE TABLE IF NOT EXISTS forecast_point (
    forecast_id   INTEGER NOT NULL,
    lead_minutes  INTEGER NOT NULL,
    target_time   INTEGER NOT NULL,
    pred_level_raw REAL NOT NULL,
    revision      REAL,
    pred_level    REAL NOT NULL,
    lower_bound   REAL,
    upper_bound   REAL,
    actual_level  REAL,
    PRIMARY KEY (forecast_id, lead_minutes)
);

CREATE TABLE IF NOT EXISTS forecast_decision (
    decision_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    forecast_id     INTEGER NOT NULL,
    selected_model  TEXT NOT NULL,
    fusion_weights  TEXT,
    revision_alpha  REAL,
    ci_scale        REAL,
    degraded        INTEGER,
    reason          TEXT,
    create_time     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alert (
    alert_id              INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id            INTEGER NOT NULL,
    forecast_id           INTEGER,
    level                 TEXT NOT NULL,
    reason                TEXT,
    peak_level            REAL,
    peak_time             INTEGER,
    lead_minutes_advantage INTEGER,
    is_reference          INTEGER NOT NULL DEFAULT 0,
    lead_hours            INTEGER,
    alert_time            INTEGER NOT NULL,
    resolve_time          INTEGER,
    status                TEXT NOT NULL DEFAULT 'active',
    -- 架构文档新增列：状态机扩展值 / 误报 / 联合研判三要素
    false_report_reason   TEXT,
    duration_min          INTEGER,
    trend                 REAL
);
CREATE INDEX IF NOT EXISTS idx_alert_station ON alert(station_id, status);

CREATE TABLE IF NOT EXISTS flood_event (
    event_id           INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id         INTEGER NOT NULL,
    start_time         INTEGER NOT NULL,
    end_time           INTEGER,
    peak_level         REAL,
    peak_time          INTEGER,
    total_rainfall     REAL,
    max_rain_intensity REAL,
    max_alert_level    TEXT,
    response_actions   TEXT,
    remark             TEXT
);

CREATE TABLE IF NOT EXISTS model (
    model_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    model_name        TEXT NOT NULL,
    version           TEXT NOT NULL,
    model_type        TEXT NOT NULL,
    algorithm_config  TEXT,
    rmse              REAL,
    mae               REAL,
    model_file        TEXT NOT NULL DEFAULT '',
    active            INTEGER NOT NULL DEFAULT 0,
    create_time       INTEGER NOT NULL,
    update_time       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task (
    task_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    task_type      TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending',
    request_json   TEXT,
    result_summary TEXT,
    error_message  TEXT,
    create_time    INTEGER NOT NULL,
    finish_time    INTEGER
);

CREATE TABLE IF NOT EXISTS agent_session (
    session_id  TEXT PRIMARY KEY,
    title       TEXT,
    status      TEXT NOT NULL DEFAULT 'active',
    create_time INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_message (
    message_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    token_usage INTEGER,
    create_time INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_message_session ON agent_message(session_id);

CREATE TABLE IF NOT EXISTS agent_tool_call (
    call_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id     TEXT NOT NULL,
    tool_name      TEXT NOT NULL,
    risk_level     TEXT NOT NULL DEFAULT 'L0',
    args_json      TEXT,
    result_summary TEXT,
    success        INTEGER NOT NULL DEFAULT 1,
    latency_ms     INTEGER,
    create_time    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_call_session ON agent_tool_call(session_id);

-- ============ 新增/改造表（架构文档第四节） ============

-- 观测时序：替代原 per-station Parquet
CREATE TABLE IF NOT EXISTS observation (
    station_id    INTEGER NOT NULL,
    ts            INTEGER NOT NULL,
    level         REAL,
    rain_observed REAL,
    rain_forecast REAL,
    PRIMARY KEY (station_id, ts)
);

-- 模拟源「上帝视角」未来降雨真值（替代 station_{id}_future.parquet）
CREATE TABLE IF NOT EXISTS future_truth (
    station_id INTEGER NOT NULL,
    ts         INTEGER NOT NULL,
    rain_true  REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (station_id, ts)
);

-- 发布记录（原型有概念无后端）
CREATE TABLE IF NOT EXISTS publish_record (
    record_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_id     INTEGER NOT NULL,
    channel_id   INTEGER NOT NULL,
    content      TEXT,
    published_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_publish_record_alert ON publish_record(alert_id);

-- 动态预警等级表（替代 station 四列固定阈值，支持 3–5 级）
CREATE TABLE IF NOT EXISTS alert_level_config (
    rank                 INTEGER PRIMARY KEY,
    name                 TEXT NOT NULL,
    level_key            TEXT NOT NULL,
    color                TEXT NOT NULL,
    water_level_threshold REAL NOT NULL,
    duration_threshold   INTEGER NOT NULL DEFAULT 60,
    description          TEXT,
    enabled              INTEGER NOT NULL DEFAULT 1
);

-- 预见期配置（原为 yaml 硬编码）
CREATE TABLE IF NOT EXISTS forecast_lead_config (
    lead_hours    INTEGER PRIMARY KEY,
    enabled       INTEGER NOT NULL DEFAULT 1,
    default_weight REAL NOT NULL DEFAULT 0.5,
    is_reserved   INTEGER NOT NULL DEFAULT 0
);

-- 数据源配置（原型 DataSourceConfig）
CREATE TABLE IF NOT EXISTS datasource_config (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    type                 TEXT NOT NULL,
    name                 TEXT NOT NULL,
    status               TEXT NOT NULL DEFAULT 'disconnected',
    endpoint             TEXT,
    refresh_interval_sec INTEGER NOT NULL DEFAULT 300,
    quality_success_rate REAL,
    quality_missing_rate REAL,
    quality_avg_latency  REAL,
    schema_json          TEXT,
    enabled              INTEGER NOT NULL DEFAULT 1,
    last_error           TEXT,
    updated_at           INTEGER NOT NULL
);

-- 发布渠道配置（原型 PublishChannelConfig）
CREATE TABLE IF NOT EXISTS publish_channel (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    type     TEXT NOT NULL,
    name     TEXT NOT NULL,
    enabled  INTEGER NOT NULL DEFAULT 1,
    endpoint TEXT,
    template TEXT
);

-- 校准记录（原型 CalibrationRecord）
CREATE TABLE IF NOT EXISTS calibration_record (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    type         TEXT NOT NULL,
    target       TEXT,
    before_json  TEXT,
    after_json   TEXT,
    preview_json TEXT,
    status       TEXT NOT NULL DEFAULT 'preview',
    executed_by  TEXT,
    note         TEXT,
    created_at   INTEGER NOT NULL
);

-- 模拟降雨注入事件（持久化，重启不丢）
CREATE TABLE IF NOT EXISTS injected_event (
    event_id          TEXT PRIMARY KEY,
    station_id        INTEGER NOT NULL,
    intensity         TEXT NOT NULL,
    intensity_label   TEXT,
    peak_mm_per_step  REAL,
    duration_minutes  INTEGER,
    start_ts          INTEGER NOT NULL,
    end_ts            INTEGER NOT NULL,
    shape_json        TEXT,
    injected_at       INTEGER NOT NULL
);
