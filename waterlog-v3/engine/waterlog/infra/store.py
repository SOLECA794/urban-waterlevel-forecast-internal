"""数据集与持久化。

历史数据集用 npz 存（不引 pandas 依赖，避免版本漂移）；
在线预测/评估记录用 sqlite（标准库 sqlite3）；
模型产物用 joblib；指标与规则用 json。
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from waterlog.config import (DATASET_PATH, DEFAULT_RULES, EVAL_DB_PATH, METRICS_PATH,
                     MODELS_DIR, N_SITES, RULES_PATH)


@dataclass
class Dataset:
    ts: np.ndarray          # (T,)   epoch 秒
    level: np.ndarray       # (T, N) m
    rain: np.ndarray        # (T, N) mm/h
    rain_fc_1h: np.ndarray
    rain_fc_3h: np.ndarray
    rain_fc_6h: np.ndarray
    rain_fc_12h: np.ndarray
    quality: np.ndarray     # (T, N) 1=ok 0=degraded

    def __len__(self) -> int:
        return int(self.ts.shape[0])

    def slice_tail(self, n: int) -> "Dataset":
        return Dataset(*(getattr(self, f)[-n:] for f in
                         ("ts", "level", "rain", "rain_fc_1h", "rain_fc_3h",
                          "rain_fc_6h", "rain_fc_12h", "quality")))

    def save(self, path: Path = DATASET_PATH) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(
            path, ts=self.ts, level=self.level, rain=self.rain,
            rain_fc_1h=self.rain_fc_1h, rain_fc_3h=self.rain_fc_3h,
            rain_fc_6h=self.rain_fc_6h, rain_fc_12h=self.rain_fc_12h,
            quality=self.quality,
        )

    @classmethod
    def load(cls, path: Path = DATASET_PATH) -> "Dataset":
        z = np.load(path)
        return cls(ts=z["ts"], level=z["level"], rain=z["rain"],
                   rain_fc_1h=z["rain_fc_1h"], rain_fc_3h=z["rain_fc_3h"],
                   rain_fc_6h=z["rain_fc_6h"], rain_fc_12h=z["rain_fc_12h"],
                   quality=z["quality"])


# ---------------------------------------------------------------- 规则

def load_rules() -> dict:
    if RULES_PATH.exists():
        try:
            rules = json.loads(RULES_PATH.read_text(encoding="utf-8"))
            merged = {**DEFAULT_RULES, **rules}
            merged["weights"] = {**DEFAULT_RULES["weights"], **rules.get("weights", {})}
            merged["min_duration_min"] = {**DEFAULT_RULES["min_duration_min"], **rules.get("min_duration_min", {})}
            merged["score_cutoffs"] = {**DEFAULT_RULES["score_cutoffs"], **rules.get("score_cutoffs", {})}
            return merged
        except Exception:
            pass
    return json.loads(json.dumps(DEFAULT_RULES))


def save_rules(rules: dict) -> dict:
    RULES_PATH.parent.mkdir(parents=True, exist_ok=True)
    RULES_PATH.write_text(json.dumps(rules, ensure_ascii=False, indent=2), encoding="utf-8")
    return rules


# ---------------------------------------------------------------- 指标

def load_metrics() -> dict:
    if METRICS_PATH.exists():
        return json.loads(METRICS_PATH.read_text(encoding="utf-8"))
    return {}


def save_metrics(metrics: dict) -> None:
    METRICS_PATH.parent.mkdir(parents=True, exist_ok=True)
    METRICS_PATH.write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")


# ---------------------------------------------------------------- 预测记录 / 评估

_SCHEMA = """
CREATE TABLE IF NOT EXISTS prediction (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issued_at INTEGER NOT NULL,
  target_at INTEGER NOT NULL,
  site_id TEXT NOT NULL,
  horizon_min INTEGER NOT NULL,
  model TEXT NOT NULL,
  yhat REAL NOT NULL,
  yhat_raw REAL NOT NULL,
  origin_level REAL,
  lower REAL,
  upper REAL,
  actual REAL,
  evaluated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pred_target ON prediction(target_at, actual);
CREATE INDEX IF NOT EXISTS idx_pred_site ON prediction(site_id, issued_at);

CREATE TABLE IF NOT EXISTS agent_decision (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  site_id TEXT NOT NULL,
  should_forecast INTEGER NOT NULL,
  model TEXT,
  correction_gain REAL,
  reason TEXT,
  signals TEXT
);
"""


class EvalStore:
    def __init__(self, path: Path = EVAL_DB_PATH):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(path), check_same_thread=False)
        self.conn.executescript(_SCHEMA)
        self._migrate()
        self.conn.commit()

    def _migrate(self) -> None:
        """给老库补列。CREATE TABLE IF NOT EXISTS 不会给已存在的表加字段，
        而 origin_level 是「持久化基线」的锚点：没有它，在线 skill 只能用
        实际值的标准差当分母，算出来会虚高到 0.98 —— 那是假指标。"""
        cols = {r[1] for r in self.conn.execute("PRAGMA table_info(prediction)").fetchall()}
        if "origin_level" not in cols:
            self.conn.execute("ALTER TABLE prediction ADD COLUMN origin_level REAL")

    def add_predictions(self, rows: list[tuple]) -> None:
        """rows: (issued_at, target_at, site_id, horizon_min, model, yhat, yhat_raw,
        origin_level, lower, upper)"""
        if not rows:
            return
        self.conn.executemany(
            "INSERT INTO prediction(issued_at,target_at,site_id,horizon_min,model,yhat,yhat_raw,"
            "origin_level,lower,upper) VALUES (?,?,?,?,?,?,?,?,?,?)", rows)
        self.conn.commit()

    def settle(self, now_ts: int, actual_by_site: dict[str, float]) -> int:
        """把到期未结算的预测与实际值对齐。"""
        if not actual_by_site:
            return 0
        cur = self.conn.execute(
            "SELECT id, site_id FROM prediction WHERE actual IS NULL AND target_at <= ?", (now_ts,))
        updates = [(actual_by_site[sid], now_ts, rid) for rid, sid in cur.fetchall() if sid in actual_by_site]
        if updates:
            self.conn.executemany("UPDATE prediction SET actual=?, evaluated_at=? WHERE id=?", updates)
            self.conn.commit()
        return len(updates)

    def settled_since(self, ts: int) -> list[tuple]:
        """本轮刚结算的 (site_id, horizon_min, yhat, actual)，用于喂给滚动修正器。"""
        rows = self.conn.execute(
            "SELECT site_id, horizon_min, yhat, actual FROM prediction"
            " WHERE evaluated_at = ? AND actual IS NOT NULL", (ts,)).fetchall()
        return [(r[0], int(r[1]), float(r[2]), float(r[3])) for r in rows]

    def window_stats(self, since_ts: int) -> dict:
        """评估看板：近 N 小时的预测精度（分预见期），直接由已结算记录算，
        不依赖训练时的验证集指标——这才是"模型上线后到底准不准"的答案。"""
        rows = self.conn.execute(
            "SELECT horizon_min, yhat, actual, origin_level FROM prediction"
            " WHERE actual IS NOT NULL AND target_at >= ?", (since_ts,)).fetchall()
        buckets: dict[int, list[tuple[float, float, float]]] = {}
        for hmin, yhat, actual, origin in rows:
            # origin_level 为空的记录是加列之前写下的，持久化基线补不出来，只能跳过 skill
            buckets.setdefault(int(hmin), []).append(
                (float(yhat), float(actual), float(origin) if origin is not None else float("nan")))
        out = {}
        for hmin, triples in sorted(buckets.items()):
            if len(triples) < 5:
                continue
            err = np.asarray([p - a for p, a, _ in triples], dtype=float)
            rmse = float(np.sqrt(np.mean(err ** 2)))
            mae = float(np.mean(np.abs(err)))
            # 持久化基线 = 发布预测那一刻的水位（不是实际值的标准差！后者会
            # 把 skill 抬高到 0.98，因为跨站点水位差异远大于预测误差）。
            persist_err = np.asarray([o - a for _, a, o in triples], dtype=float)
            persist_rmse = float(np.sqrt(np.nanmean(persist_err ** 2)))
            skill = float(1 - rmse / persist_rmse) if persist_rmse > 1e-9 else 0.0
            out[str(hmin)] = {
                "n": int(err.size),
                "rmse": round(rmse, 4), "mae": round(mae, 4),
                "bias": round(float(np.mean(err)), 4),
                "p95_abs": round(float(np.percentile(np.abs(err), 95)), 4),
                "baseline_rmse": round(persist_rmse, 4),
                "skill": round(skill, 4),
            }
        return out

    def recent_pairs(self, since_ts: int, site_id: str | None = None, limit: int = 2000) -> list[tuple]:
        sql = ("SELECT target_at, site_id, horizon_min, model, yhat, yhat_raw, actual, lower, upper,"
               " origin_level FROM prediction WHERE actual IS NOT NULL AND target_at >= ?")
        args: list = [since_ts]
        if site_id:
            sql += " AND site_id = ?"
            args.append(site_id)
        sql += " ORDER BY target_at DESC LIMIT ?"
        args.append(limit)
        return self.conn.execute(sql, args).fetchall()

    def drop_pending(self) -> int:
        """丢弃尚未结算的预测。

        清零会改写世界状态：清零前发布的预测，其目标时刻仍指向那条
        被抹掉的洪水时间线，结算出来的误差是几米级，会把在线 skill 污染成
        一个漂亮但假的数字。这些预测已经失去被评估的意义，只能作废——
        作废而不是让它们参与统计，才是诚实的处理。
        """
        n = int(self.conn.execute("SELECT COUNT(*) FROM prediction WHERE actual IS NULL").fetchone()[0])
        if n:
            self.conn.execute("DELETE FROM prediction WHERE actual IS NULL")
            self.conn.commit()
        return n

    def pending_count(self) -> int:
        return int(self.conn.execute("SELECT COUNT(*) FROM prediction WHERE actual IS NULL").fetchone()[0])

    def add_decision(self, ts: int, site_id: str, should: bool, model: str | None,
                     gain: float | None, reason: str, signals: dict) -> None:
        self.conn.execute(
            "INSERT INTO agent_decision(ts,site_id,should_forecast,model,correction_gain,reason,signals)"
            " VALUES (?,?,?,?,?,?,?)",
            (ts, site_id, int(should), model, gain, reason, json.dumps(signals, ensure_ascii=False)))
        self.conn.commit()

    def recent_decisions(self, limit: int = 50) -> list[dict]:
        rows = self.conn.execute(
            "SELECT ts,site_id,should_forecast,model,correction_gain,reason,signals"
            " FROM agent_decision ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        out = []
        for ts, sid, should, model, gain, reason, signals in rows:
            out.append({"ts": ts, "site_id": sid, "should_forecast": bool(should), "model": model,
                        "correction_gain": gain, "reason": reason,
                        "signals": json.loads(signals) if signals else {}})
        return out


# ---------------------------------------------------------------- 模型产物

def model_path(version: str) -> Path:
    return MODELS_DIR / f"{version}.joblib"


def ensure_dirs() -> None:
    for p in (DATASET_PATH.parent, MODELS_DIR):
        p.mkdir(parents=True, exist_ok=True)


def merge_rules(base: dict, patch: dict) -> dict:
    """把候选改动叠到现有规则上（只合并，不落盘）。

    三个子字典要逐键合并而不是整块替换：前端只改 red 分档时，
    传上来的 score_cutoffs 只有 {red: 0.9}，整块替换会把另外三级抹掉。
    """
    merged = {**base}
    for k, v in patch.items():
        if not isinstance(v, dict):
            merged[k] = v
    for key in ("weights", "min_duration_min", "score_cutoffs"):
        if isinstance(patch.get(key), dict):
            merged[key] = {**base.get(key, {}), **patch[key]}
    return merged
