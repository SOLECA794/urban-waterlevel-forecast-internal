"""一键引导：造历史数据 → 训练模型 → 热启动修正器 → 落盘。

跑一次大概 30~60 秒（60 天 × 288 步/天 × 10 站点 ≈ 17 万条站点-时刻样本）。
产物全部在 engine/data/ 下，删掉这个目录就等于重置。

    python -m waterlog.cli.bootstrap            # 全量重建
    python -m waterlog.cli.bootstrap --keep     # 已有数据集就只重训模型
"""

from __future__ import annotations

import argparse
import json
import time

import numpy as np

from waterlog.config import (DATASET_PATH, DATA_DIR, HISTORY_DAYS, N_SITES, SIM_SEED,
                     STEP_MIN, STEP_SEC)
from waterlog.domain.hydrology import Simulator
from waterlog.infra.store import Dataset, EvalStore, ensure_dirs, load_metrics, save_metrics


def build_dataset(days: int = HISTORY_DAYS, seed: int = SIM_SEED) -> Dataset:
    total = days * 24 * 60 // STEP_MIN
    print(f"[bootstrap] 仿真 {days} 天 × {N_SITES} 站点 = {total} 步 ...", flush=True)
    t0 = time.time()
    sim = Simulator(seed=seed, start_step=0)
    out = sim.advance(total)
    print(f"[bootstrap] 仿真完成 {time.time() - t0:.1f}s", flush=True)

    # 时间轴：结束于"现在"，按 5 分钟对齐
    now = int(time.time())
    end = now - (now % STEP_SEC)
    ts = (end - (total - 1 - np.arange(total)) * STEP_SEC).astype(np.int64)

    ds = Dataset(ts=ts, level=out["level"], rain=out["rain"],
                 rain_fc_1h=out["rain_fc_1h"], rain_fc_3h=out["rain_fc_3h"],
                 rain_fc_6h=out["rain_fc_6h"], rain_fc_12h=out["rain_fc_12h"],
                 quality=out["quality"])

    # 仿真器状态落盘，在线服务从这一刻接着往前推
    st = sim.state()
    np.savez_compressed(DATA_DIR / "sim_state.npz", **st)
    # 重建数据集时必须清掉旧的仿真时钟：否则新数据配旧时钟，
    # 时间轴会从「上次跑到哪儿」接着走，而不是从这份新数据的末尾开始。
    clock = DATA_DIR / "sim_clock.json"
    if clock.exists():
        clock.unlink()
    ds.save(DATASET_PATH)
    print(f"[bootstrap] 数据集已保存 {DATASET_PATH}  shape={ds.level.shape}", flush=True)
    return ds


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true", help="复用已有数据集，只重训模型")
    ap.add_argument("--days", type=int, default=HISTORY_DAYS)
    ap.add_argument("--seed", type=int, default=SIM_SEED)
    args = ap.parse_args()

    ensure_dirs()
    if args.keep and DATASET_PATH.exists():
        ds = Dataset.load(DATASET_PATH)
        print(f"[bootstrap] 复用数据集 shape={ds.level.shape}", flush=True)
    else:
        ds = build_dataset(args.days, args.seed)

    from waterlog.ml.models import train
    print("[bootstrap] 训练模型 ...", flush=True)
    t0 = time.time()
    result = train(ds, progress=lambda i, n, h: print(f"  预见期 {h}min 完成 ({i}/{n})", flush=True))
    metrics = load_metrics()
    metrics["latest"] = result.to_json()
    metrics.setdefault("history", []).append({
        "version": result.version, "trained_at": result.trained_at,
        "rmse_3h": next((m["rmse"] for m in result.metrics["blend"] if m["horizon_min"] == 180), None),
        "skill_3h": next((m["skill_vs_persistence"] for m in result.metrics["blend"] if m["horizon_min"] == 180), None),
    })
    metrics["history"] = metrics["history"][-20:]
    save_metrics(metrics)
    print(f"[bootstrap] 训练完成 {time.time() - t0:.1f}s  版本 {result.version}", flush=True)

    for m in result.metrics["blend"]:
        print(f"  {m['horizon_min']:>4}min  RMSE={m['rmse']:.3f}m  MAE={m['mae']:.3f}m  "
              f"NSE={m['nse']:.3f}  skill={m['skill_vs_persistence']:+.3f}  "
              f"PICP90={m['picp90']:.1f}%  CRPS={m['crps']:.3f}", flush=True)

    # 热启动滚动修正器：用最近 3 天做离线回放
    from waterlog.service.forecast import ForecastService
    from waterlog.ml.models import load_bundle
    print("[bootstrap] 热启动滚动修正器 ...", flush=True)
    svc = ForecastService(ds, load_bundle())
    svc.warmup_corrector(ds)
    (DATA_DIR / "corrector.json").write_text(
        json.dumps(svc.corrector.state(), ensure_ascii=False, indent=2), encoding="utf-8")

    # 评估库重置（新模型 = 新起跑线，旧记录不混进来）
    svc.store.conn.close()
    db = DATA_DIR / "eval.sqlite"
    if db.exists():
        db.unlink()
    EvalStore()

    print("[bootstrap] 完成。下一步：python -m app.api", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
