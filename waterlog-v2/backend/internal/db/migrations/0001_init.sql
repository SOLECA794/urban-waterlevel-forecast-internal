-- v2 领域模型：对标 ThingsBoard 设备画像 / 遥测 / 规则链 / 告警四态生命周期
-- 全部时间戳为 unix 秒（INTEGER），与前端 API 契约一致。

CREATE TABLE IF NOT EXISTS device_profile (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL UNIQUE,          -- 画像名，如「雷达水位计」
    category        TEXT    NOT NULL DEFAULT 'water_level',
    telemetry_keys  TEXT    NOT NULL DEFAULT '[]',     -- JSON: ["water_level","rainfall"]
    description     TEXT    NOT NULL DEFAULT '',
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS device (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id    INTEGER NOT NULL REFERENCES device_profile(id),
    name          TEXT    NOT NULL,
    code          TEXT    NOT NULL UNIQUE,             -- 设备编码（遥测上报用）
    lat           REAL,
    lon           REAL,
    address       TEXT    NOT NULL DEFAULT '',
    status        TEXT    NOT NULL DEFAULT 'offline',  -- online / stale / offline
    enabled       INTEGER NOT NULL DEFAULT 1,
    last_seen_at  INTEGER,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_profile ON device(profile_id);

CREATE TABLE IF NOT EXISTS telemetry_kv (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL REFERENCES device(id) ON DELETE CASCADE,
    metric    TEXT    NOT NULL,
    ts        INTEGER NOT NULL,
    value     REAL    NOT NULL,
    quality   TEXT    NOT NULL DEFAULT 'good'
);
CREATE INDEX IF NOT EXISTS idx_tk_device_metric_ts ON telemetry_kv(device_id, metric, ts);
CREATE INDEX IF NOT EXISTS idx_tk_ts ON telemetry_kv(ts);

CREATE TABLE IF NOT EXISTS rule_chain (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rule_node (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    chain_id           INTEGER NOT NULL REFERENCES rule_chain(id) ON DELETE CASCADE,
    name               TEXT    NOT NULL,
    device_profile_id  INTEGER REFERENCES device_profile(id),
    metric             TEXT    NOT NULL,
    op                 TEXT    NOT NULL,                -- gt / gte / lt / lte
    threshold          REAL    NOT NULL,
    duration_sec       INTEGER NOT NULL DEFAULT 0,
    level_key          TEXT    NOT NULL,                -- blue / yellow / orange / red
    level_rank         INTEGER NOT NULL DEFAULT 1,
    severity           TEXT    NOT NULL DEFAULT 'warning',
    actions            TEXT    NOT NULL DEFAULT '[]',   -- JSON: ["sse","log","webhook"]
    priority           INTEGER NOT NULL DEFAULT 100,
    enabled            INTEGER NOT NULL DEFAULT 1,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rule_node_chain ON rule_node(chain_id);

-- 告警四态：ACTIVE_UNACK → ACTIVE_ACK；ACTIVE_* → CLEARED_*（正交维度：在线/已恢复 × 未确认/已确认）
CREATE TABLE IF NOT EXISTS alarm (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id     INTEGER NOT NULL REFERENCES device(id),
    rule_node_id  INTEGER,
    level_key     TEXT    NOT NULL,
    level_rank    INTEGER NOT NULL,
    severity      TEXT    NOT NULL DEFAULT 'warning',
    status        TEXT    NOT NULL,
    start_ts      INTEGER NOT NULL,
    ack_ts        INTEGER,
    ack_by        TEXT,
    clear_ts      INTEGER,
    cleared_by    TEXT,
    clear_reason  TEXT,                                  -- auto / manual / false_report
    trigger_value REAL,
    current_value REAL,
    message       TEXT    NOT NULL DEFAULT '',
    updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alarm_status ON alarm(status);
CREATE INDEX IF NOT EXISTS idx_alarm_device ON alarm(device_id, start_ts);

CREATE TABLE IF NOT EXISTS dashboard (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    layout     TEXT    NOT NULL DEFAULT '[]',            -- JSON grid
    widgets    TEXT    NOT NULL DEFAULT '[]',            -- JSON widget 定义
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    ts     INTEGER NOT NULL,
    actor  TEXT    NOT NULL DEFAULT 'system',
    action TEXT    NOT NULL,
    target TEXT,
    detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
