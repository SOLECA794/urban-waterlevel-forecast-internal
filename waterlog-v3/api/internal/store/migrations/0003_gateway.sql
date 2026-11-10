-- 0003: AI 平台自研网关的任务台账与事件幂等表
--
-- 为什么这两张表在 SQLite 而不是内存：
--
--   1. A-6 的 requestId 幂等语义要求「重复提交返回同一 taskId」。
--      只放内存的话，对方重试一次就开出第二个任务，
--      对方那边看到的任务数会与我们这边对不上。
--   2. 条款 9-9 要求预测运行有台账、可查历史。内存里的记录重启就没了，
--      而台账恰恰是「重启后最需要还在」的东西。
--   3. A-9 的事件去重同理：同一事件重复推送必须只留一条，
--      否则事件生命周期查询会返回重复行，对方对账时对不上。

-- 预测任务台账。
--
-- request_id 上有唯一索引——幂等就是靠数据库约束保证的，
-- 不是靠「先查再插」的应用层逻辑（那在并发下必然有窗口）。
CREATE TABLE IF NOT EXISTS aiwater_task (
    task_id       TEXT PRIMARY KEY,
    request_id    TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'queued',  -- queued/running/success/failed
    progress      INTEGER NOT NULL DEFAULT 0,     -- 0~100
    error_code    TEXT NOT NULL DEFAULT '',
    error_msg     TEXT NOT NULL DEFAULT '',
    point_codes   TEXT NOT NULL DEFAULT '[]',      -- JSON 数组
    periods       TEXT NOT NULL DEFAULT '[]',      -- JSON 数组
    model_version TEXT NOT NULL DEFAULT '',
    begin_time    INTEGER NOT NULL DEFAULT 0,      -- 时间区间下界（仿真时钟秒）
    end_time      INTEGER NOT NULL DEFAULT 0,      -- 时间区间上界（仿真时钟秒）
    result_list   TEXT NOT NULL DEFAULT '[]',      -- JSON 数组
    callback_url  TEXT NOT NULL DEFAULT '',
    callback_status TEXT NOT NULL DEFAULT '',      -- ok / failed / skipped
    callback_msg  TEXT NOT NULL DEFAULT '',
    submit_time   INTEGER NOT NULL DEFAULT 0,      -- 墙钟 Unix 秒
    update_time   INTEGER NOT NULL DEFAULT 0       -- 墙钟 Unix 秒
);

-- 幂等查询：按 request_id 找已有任务。
CREATE UNIQUE INDEX IF NOT EXISTS idx_aiwater_task_request ON aiwater_task(request_id);

-- 运维查最近任务用。
CREATE INDEX IF NOT EXISTS idx_aiwater_task_status ON aiwater_task(status, submit_time DESC);

-- 事件生命周期记录（幂等表）。
--
-- 主键是 (event_id, stage)：同一事件的同一阶段只留一条，
-- 但同一事件的不同阶段都要留——那正是「全生命周期」三个字的含义。
CREATE TABLE IF NOT EXISTS aiwater_event (
    event_id      TEXT NOT NULL,
    point_code    TEXT NOT NULL DEFAULT '',
    stage         TEXT NOT NULL DEFAULT '',
    operator      TEXT NOT NULL DEFAULT '',
    operate_time  INTEGER NOT NULL DEFAULT 0,      -- 对方给的真实时间 Unix 秒
    conclusion    TEXT NOT NULL DEFAULT '',
    evidence_urls TEXT NOT NULL DEFAULT '[]',      -- JSON 数组
    source        TEXT NOT NULL DEFAULT 'icm',      -- icm / local
    payload_hash  TEXT NOT NULL DEFAULT '',
    received_at   INTEGER NOT NULL DEFAULT 0,      -- 我方收到时刻（墙钟）
    updated_at    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (event_id, stage)
);

-- 按点位 + 时间查生命周期（A-8 的主查询路径）。
CREATE INDEX IF NOT EXISTS idx_aiwater_event_point ON aiwater_event(point_code, operate_time DESC);

-- 按事件号查全部阶段（A-8 的 eventId 查询路径）。
CREATE INDEX IF NOT EXISTS idx_aiwater_event_id ON aiwater_event(event_id, operate_time DESC);
