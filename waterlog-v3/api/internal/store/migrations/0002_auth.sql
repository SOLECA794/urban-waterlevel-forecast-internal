-- 0002: 账号、会话、审计、通知渠道
--
-- 为什么账号与会话都在 SQLite 而不是内存：
-- 重启后值班员不该被踢出去（值班是 8 小时一班，重启是常态），
-- 审计更是必须落盘的——内存里的审计在事故复盘时一文不值。

CREATE TABLE IF NOT EXISTS app_user (
    username      TEXT PRIMARY KEY,
    display_name  TEXT NOT NULL DEFAULT '',
    role          TEXT NOT NULL DEFAULT 'viewer',   -- admin / operator / viewer
    pwd_hash      TEXT NOT NULL,                    -- pbkdf2$<iter>$<salt_b64>$<hash_b64>
    disabled      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL DEFAULT 0,
    last_login_at INTEGER
);

-- 会话表只存 token 的 SHA-256，不存原文：
-- 库文件泄露时，攻击者拿到的摘要无法直接当 cookie 用。
CREATE TABLE IF NOT EXISTS app_session (
    token_hash TEXT PRIMARY KEY,
    username   TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_user ON app_session(username);

-- 审计只记写操作。读接口记了就是噪声——值班员一天刷两百次一张图，
-- 这些记录会把真正要查的那一条埋掉。
CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         INTEGER NOT NULL,
    username   TEXT NOT NULL DEFAULT '',
    role       TEXT NOT NULL DEFAULT '',
    method     TEXT NOT NULL,
    path       TEXT NOT NULL,
    status     INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    ip         TEXT NOT NULL DEFAULT '',
    summary    TEXT NOT NULL DEFAULT '',
    request_id TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(username, at DESC);

CREATE TABLE IF NOT EXISTS notify_channel (
    name        TEXT PRIMARY KEY,              -- inapp / webhook / email / sms
    enabled     INTEGER NOT NULL DEFAULT 0,
    endpoint    TEXT NOT NULL DEFAULT '',
    secret      TEXT NOT NULL DEFAULT '',
    min_level   TEXT NOT NULL DEFAULT 'orange',-- 达到该等级才推送
    debounce_min INTEGER NOT NULL DEFAULT 15,
    updated_at  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS notify_delivery (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         INTEGER NOT NULL,
    channel    TEXT NOT NULL,
    site_id    TEXT NOT NULL DEFAULT '',
    level      TEXT NOT NULL DEFAULT '',
    ok         INTEGER NOT NULL DEFAULT 0,
    detail     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_delivery_at ON notify_delivery(at DESC);
