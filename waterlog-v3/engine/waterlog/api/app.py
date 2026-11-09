"""FastAPI 服务：对外只暴露"读状态 / 改规则 / 重训"三类接口。

运行：
    python -m app.api                     # 默认 127.0.0.1:8201
    WL_ENGINE_PORT=8202 python -m app.api

设计取舍：
- **推送到 Go**：每个 tick 把遥测推到 Go API，每个预测周期把快照推过去。
  Go 负责存储/SSE/前端，Python 只负责算。这样前端只跟一个源打交道，不用跨域。
- **Go 不在也不崩**：推送失败只记日志，Python 自己照常跑，本地调试不受影响。
- **重训是后台任务**：90 秒的训练不能阻塞事件循环，也不能让前端等到超时。
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import urllib.error
import urllib.request
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from waterlog.config import (DATA_DIR, ENGINE_PORT, FORECAST_EVERY_SEC, GO_API_URL,
                     HISTORY_DAYS, MODELS_DIR, N_SITES, PUSH_ENABLED, SITE_BY_ID,
                     SITE_IDS, SITES, STEP_MIN, STEP_SEC, TICK_SEC)
from waterlog.domain.features import FEATURE_NAMES
from waterlog.service.forecast import ForecastService
from waterlog.ml.models import load_bundle, train
from waterlog.domain.hydrology import Simulator
from waterlog.infra.store import Dataset, EvalStore, load_metrics, load_rules, save_metrics, save_rules

log = logging.getLogger("engine")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

STATE: dict = {}


# ------------------------------------------------------------------ 推送

def _post(path: str, payload: dict, timeout: float = 2.0) -> bool:
    if not PUSH_ENABLED:
        return False
    url = GO_API_URL.rstrip("/") + path
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"},
                                 method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status < 400
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        log.debug("push %s failed: %s", path, exc)
        return False


# ------------------------------------------------------------------ 生命周期

SIM_CLOCK_PATH = DATA_DIR / "sim_clock.json"


def _load_sim(ds: Dataset) -> tuple[Simulator, int, int]:
    """返回 (模拟器, 起始步号, 时间轴基准 ts)。

    基准 ts 必须续着上次的跑，不能回退到数据集末尾：模拟器是 60x 加速的，
    跑一阵子仿真时间就远超数据集末尾，重启若把时间轴拨回去，会出现
    - 遥测 ts 倒退，Go 的 MAX(ts) 卡在旧的未来时刻，一张图直接定格；
    - 新预测的 issued_at 比旧快照小，Go 按 issued_at DESC 取到的是**旧预测**。
    这两种都是静默错误，所以宁可多存一个时钟文件。
    """
    sim = Simulator(seed=0, start_step=0)
    st_path = DATA_DIR / "sim_state.npz"
    if not st_path.exists():
        raise RuntimeError("缺少 sim_state.npz，请先执行 python -m waterlog.cli.bootstrap")
    z = np.load(st_path)
    sim.load_state({k: z[k] for k in z.files})
    start_step = sim.step
    sim.rain.ensure(sim.step + 12 * 60 // 5 + 4)

    base_ts = int(ds.ts[-1])
    if SIM_CLOCK_PATH.exists():
        try:
            saved = int(json.loads(SIM_CLOCK_PATH.read_text(encoding="utf-8"))["last_ts"])
            if saved > base_ts:
                base_ts = saved
        except Exception:
            log.warning("sim_clock.json 读不出来，按数据集末尾计时")

    # 再问一次 Go：它库里记着 MAX(telemetry.ts)，那是它已经认定"现在"的时刻。
    # 时间轴不允许比它更早，否则前端会定格在旧时刻，而新预测还会被旧快照盖住。
    try:
        with urllib.request.urlopen(f"{GO_API_URL}/api/health", timeout=2.0) as resp:
            go_ts = int(json.loads(resp.read().decode()).get("ts") or 0)
        if go_ts > base_ts:
            log.warning("仿真时钟落后于 Go 已有遥测（%s < %s），前移到 %s",
                        base_ts, go_ts, go_ts)
            base_ts = go_ts
    except Exception as exc:
        log.info("启动时没读到 Go 时钟（%s），按本地时钟计时", exc)

    # 还要保证新一轮预测能盖住上一轮：Go 取最新快照是按 issued_at 倒序，
    # 只要历史里存在比 base_ts 更晚的 issued_at，新预测就会一直被旧快照压住。
    try:
        with urllib.request.urlopen(f"{GO_API_URL}/api/forecast", timeout=2.0) as resp:
            prev_issued = int(json.loads(resp.read().decode()).get("issued_at") or 0)
        if prev_issued >= base_ts:
            log.warning("库里有更晚的预测快照（%s），时间轴前移到其后一步", prev_issued)
            base_ts = prev_issued + STEP_SEC
    except Exception as exc:
        log.info("启动时没读到 Go 旧快照（%s）", exc)
    return sim, start_step, base_ts


def _save_sim() -> None:
    """把模拟器状态与仿真时钟落盘，供下次启动续跑。"""
    sim: Simulator | None = STATE.get("sim")
    last_ts = STATE.get("last_ts")
    if sim is None or not last_ts:
        return
    try:
        np.savez(DATA_DIR / "sim_state.npz", **sim.state())
        SIM_CLOCK_PATH.write_text(json.dumps({"last_ts": int(last_ts)}), encoding="utf-8")
    except Exception:
        log.exception("保存模拟器状态失败（不影响本次运行）")


async def _loop() -> None:
    sim: Simulator = STATE["sim"]
    svc: ForecastService = STATE["svc"]
    ds_full: Dataset = STATE["ds_full"]
    start_step: int = STATE["sim_start_step"]
    base_ts = int(STATE["base_ts"])
    last_fc = 0.0
    ticks = 0
    log.info("engine loop started, tick=%.1fs forecast_every=%.0fs", TICK_SEC, FORECAST_EVERY_SEC)
    while True:
        try:
            out = sim.advance(1)
            step0 = int(out["step"][0])
            ts0 = base_ts + (step0 - start_step + 1) * STEP_SEC
            svc.buf.push(out, ts0)

            # 推遥测
            rows = [{"ts": ts0, "site_id": SITE_IDS[i],
                     "level": round(float(out["level"][0, i]), 4),
                     "rain": round(float(out["rain"][0, i]), 2),
                     "quality": int(out["quality"][0, i]),
                     "rain_fc_1h": round(float(out["rain_fc_1h"][0, i]), 2),
                     "rain_fc_3h": round(float(out["rain_fc_3h"][0, i]), 2)}
                    for i in range(N_SITES)]
            STATE["last_ts"] = ts0
            asyncio.create_task(asyncio.to_thread(_post, "/api/ingest/telemetry", {"rows": rows}))

            # 第一个 tick 就落一次盘，之后每 12 个 tick（约 1 分钟墙钟 / 1 小时仿真）
            # 落一次。只写 60 的倍数是不够的：刚启动就被停掉的进程留不下任何时钟，
            # 下次重启又回到数据集末尾。
            ticks += 1
            if ticks == 1 or ticks % 12 == 0:
                await asyncio.to_thread(_save_sim)

            if time.time() - last_fc >= FORECAST_EVERY_SEC:
                last_fc = time.time()
                await asyncio.to_thread(_forecast_cycle)
        except Exception:
            log.exception("loop iteration failed")
        await asyncio.sleep(TICK_SEC)


def _forecast_cycle() -> None:
    svc: ForecastService = STATE["svc"]
    now_ts = svc.buf.now_ts
    svc.settle(now_ts)
    payload = svc.cycle()
    STATE["last_forecast"] = payload
    STATE["last_forecast_at"] = time.time()
    _post("/api/ingest/forecast", payload, timeout=4.0)
    log.info("forecast cycle #%d sites=%d", svc.cycle_count, len(payload["sites"]))


@asynccontextmanager
async def lifespan(app: FastAPI):
    ds_full = Dataset.load()
    svc = ForecastService(ds_full, load_bundle())
    corr_path = DATA_DIR / "corrector.json"
    if corr_path.exists():
        svc.corrector.load(json.loads(corr_path.read_text(encoding="utf-8")))
    sim, start_step, base_ts = _load_sim(ds_full)

    STATE.update({"ds_full": ds_full, "svc": svc, "sim": sim, "sim_start_step": start_step,
                  "base_ts": base_ts,
                  "started_at": time.time(), "last_ts": int(ds_full.ts[-1]),
                  "last_forecast": None, "last_forecast_at": 0.0, "retrain": None})
    # 启动即出一次预测，前端不用等 60 秒
    await asyncio.to_thread(_forecast_cycle)
    task = asyncio.create_task(_loop())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        _save_sim()
        svc.store.conn.close()


app = FastAPI(title="waterlog-v3 engine", version="3.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# ------------------------------------------------------------------ 接口

@app.get("/health")
def health() -> dict:
    svc: ForecastService = STATE["svc"]
    return {"ok": True, "model_version": svc.bundle.get("version"),
            "cycles": svc.cycle_count, "pending": svc.store.pending_count(),
            "uptime_s": round(time.time() - STATE["started_at"], 1),
            "last_ts": STATE["last_ts"]}


@app.get("/sites")
def sites() -> dict:
    return {"sites": [
        {"id": s.id, "name": s.name, "district": s.district, "lon": s.lon, "lat": s.lat,
         "base_level": s.base_level, "thresholds": list(s.thresholds), "kind": s.kind,
         "catchment_ha": s.catchment_ha, "pond_ha": s.pond_ha, "impervious": s.impervious,
         "drainage_mm_h": s.drainage_mm_h}
        for s in SITES]}


@app.get("/state")
def state() -> dict:
    svc: ForecastService = STATE["svc"]
    payload = STATE.get("last_forecast")
    if payload is None:
        payload = svc.cycle()
    return payload


@app.get("/forecast")
def forecast() -> dict:
    return STATE.get("last_forecast") or {}


@app.get("/history")
def history(site: str = "S01", hours: int = 24) -> dict:
    # 用实时缓冲区，而不是启动时冻结的 ds_full——否则详情页看不到刚推进的数据
    svc: ForecastService = STATE["svc"]
    ds: Dataset = svc.buf.ds
    if site not in SITE_BY_ID:
        raise HTTPException(404, "unknown site")
    i = SITE_IDS.index(site)
    n = min(len(ds), max(1, hours * 60 // 5))
    sl = slice(len(ds) - n, len(ds))
    return {"site_id": site, "step_min": 5,
            "points": [[int(t), round(float(v), 4), round(float(r), 2)]
                       for t, v, r in zip(ds.ts[sl], ds.level[sl, i], ds.rain[sl, i])]}


@app.get("/rules")
def get_rules() -> dict:
    return load_rules()


@app.put("/rules")
def put_rules(rules: dict) -> dict:
    svc: ForecastService = STATE["svc"]
    merged = save_rules({**svc.rules, **rules})
    svc.rules = merged
    payload = svc.cycle()          # 规则一改，立刻重算一遍等级
    STATE["last_forecast"] = payload
    _post("/api/ingest/forecast", payload, timeout=4.0)
    return {"ok": True, "rules": merged}


@app.post("/rules/preview")
def preview_rules(patch: dict) -> dict:
    """规则影响预演：同样的预报，换一套规则，等级会怎么变。

    只读，不落盘——预演完用户点「保存」才真正生效。
    """
    svc: ForecastService = STATE["svc"]
    if not svc.last_series:
        raise HTTPException(409, "尚无预测结果，无法预演")
    return svc.preview_rules(patch)


@app.get("/models/versions")
def model_versions() -> dict:
    """可采纳的模型版本清单。

    重训必须配回滚：新版本离线指标更好，但上线后可能不对（数据漂移、
    某些站点变差）。这时候值班员要能一键退回上一版，而不是再等 90 秒重训。
    """
    active = ""
    ptr = MODELS_DIR / "latest.txt"
    if ptr.exists():
        active = ptr.read_text(encoding="utf-8").strip()
    hist = {h["version"]: h for h in load_metrics().get("history", [])}
    cache: dict = STATE.setdefault("version_meta", {})
    out = []
    for p in MODELS_DIR.glob("*.joblib"):
        v = p.stem
        meta = cache.get(v)
        if meta is None:
            try:
                b = load_bundle(v)
                meta = {"trained_at": int(b.get("trained_at", 0)),
                        "train_seconds": round(float(b.get("train_seconds", 0.0)), 1),
                        "folds": int(b.get("folds", 0))}
            except Exception:
                meta = {"trained_at": 0, "train_seconds": 0.0, "folds": 0}
            cache[v] = meta
        h = hist.get(v, {})
        out.append({"version": v, "trained_at": meta["trained_at"],
                    "train_seconds": meta["train_seconds"], "folds": meta["folds"],
                    "rmse_3h": h.get("rmse_3h"), "skill_3h": h.get("skill_3h"),
                    "size_mb": round(p.stat().st_size / 1048576.0, 2),
                    "active": v == active})
    out.sort(key=lambda r: (r["trained_at"], r["version"]), reverse=True)
    return {"versions": out, "active": active}


@app.post("/models/adopt")
def model_adopt(version: str) -> dict:
    """采纳（或回滚到）某个已训练的版本。"""
    svc: ForecastService = STATE["svc"]
    path = MODELS_DIR / f"{version}.joblib"
    if not path.exists():
        raise HTTPException(404, f"版本不存在：{version}")
    bundle = load_bundle(version)          # 先能加载再改指针，避免指针指向坏文件
    (MODELS_DIR / "latest.txt").write_text(version, encoding="utf-8")
    svc.bundle = bundle
    log.info("adopt model %s", version)
    payload = svc.cycle()
    STATE["last_forecast"] = payload
    _post("/api/ingest/forecast", payload, timeout=4.0)
    return {"ok": True, "version": version,
            "model_version": bundle.get("version", version)}


@app.get("/metrics")
def metrics(window_h: int = 6) -> dict:
    m = load_metrics()
    svc: ForecastService = STATE["svc"]
    # 窗口起点必须用**仿真时钟**，不能用 time.time()：模拟器按 60x 加速跑，
    # 仿真时间已经跑到墙上时钟前面好几个小时，用墙上时钟算窗口会把整段历史都框进来。
    since = int(svc.buf.now_ts) - max(1, window_h) * 3600
    latest = dict(m.get("latest", {}))
    latest["n_features"] = len(FEATURE_NAMES)
    return {"latest": latest, "history": m.get("history", []),
            "rolling": svc.store.window_stats(since),
            "rolling_window_h": max(1, window_h)}


@app.get("/decisions")
def decisions(limit: int = 40) -> dict:
    svc: ForecastService = STATE["svc"]
    return {"decisions": svc.store.recent_decisions(limit)}


@app.get("/eval/pairs")
def eval_pairs(site: str | None = None, hours: int = 12) -> dict:
    svc: ForecastService = STATE["svc"]
    # 同上：用仿真时钟，否则「最近 12 小时」在这个 60x 加速的进程里等于「最近 12 分钟」。
    since = int(svc.buf.now_ts) - max(1, hours) * 3600
    rows = svc.store.recent_pairs(since, site, limit=4000)
    # base_level 一起带出去：跨站点水位基准差着十几米，前端要画「积水深」
    # 才有可比性，画绝对水位会变成一堆互不相干的簇。
    return {"pairs": [{"target_at": r[0], "site_id": r[1], "horizon_min": r[2], "model": r[3],
                       "yhat": round(r[4], 4), "actual": round(r[6], 4) if r[6] is not None else None,
                       "lower": r[7], "upper": r[8],
                       "origin_level": round(r[9], 4) if r[9] is not None else None,
                       "base_level": round(SITE_BY_ID[r[1]].base_level, 4)
                       if r[1] in SITE_BY_ID else 0.0} for r in rows]}


@app.post("/sim/storm")
def sim_storm(peak: float = 90.0, dur: int = 24) -> dict:
    """演练用：立刻注入一场暴雨。

    真实系统里没有这个接口（雨是天上下的），这里是为了让演示不必等雨：
    注入后 1~3 分钟内就能看到预警从“无”升到黄/橙，退水后再转“已解除”，
    完整走一遍四态闭环。
    """
    sim: Simulator = STATE["sim"]
    if not (3.0 <= peak <= 300.0):
        raise HTTPException(400, "peak 需在 3~300 mm/h")
    st = sim.inject_storm(peak=peak, dur=max(6, min(96, dur)))
    log.info("inject storm peak=%.0fmm/h dur=%dsteps at step=%d", st.peak, st.dur, st.start)
    return {"ok": True, "storm": {"start_step": st.start, "dur_steps": st.dur,
                                  "peak_mm_h": round(st.peak, 1),
                                  "sim_minutes": st.dur * STEP_MIN}}


@app.post("/sim/reset-water")
def sim_reset_water(clear_sky: bool = True) -> dict:
    """演练用：把所有站点积水清零，并立刻重算一轮研判。

    注入暴雨后水位会在阈值之上待十几个小时（管网满负荷、退水慢），
    验收四态闭环时不必干等：clear_sky=True 顺带把天上的雨停掉，
    这样「升 → 解除」整个过程几分钟内就能确定性地走完。
    """
    sim: Simulator = STATE["sim"]
    svc: ForecastService = STATE["svc"]
    # 先作废未结算预测：清零前发出的预测瞄准的是被抹掉的那条洪水曲线，
    # 留着它们结算只会把在线 skill 抬成一个假数字。
    dropped = svc.store.drop_pending()
    n = sim.reset_water(clear_sky=clear_sky)
    # 只清 sim.h 不够：特征缓冲里还留着清零前的洪水过程，
    # 模型看到“近期下了 160mm/h、水位刚暴跌”会预测一个 3~6 小时后的回弹，
    # 研判于是继续报黄。这里把缓冲当成一张白纸重写：
    # 各站水位=基准高程、近期无雨、传感器正常——即“这座城市从没下过雨”。
    try:
        ds = svc.buf.ds
        base = np.array([SITE_BY_ID[sid].base_level for sid in SITE_IDS], dtype=float)
        ds.level[:, :] = base[None, :]
        ds.rain[:, :] = 0.0
        ds.rain_fc_1h[:, :] = 0.0
        ds.rain_fc_3h[:, :] = 0.0
        ds.rain_fc_6h[:, :] = 0.0
        ds.rain_fc_12h[:, :] = 0.0
        ds.quality[:, :] = 1.0
    except Exception as exc:  # noqa: BLE001
        log.warning("清零缓冲失败: %s", exc)
    try:
        _forecast_cycle()
    except Exception as exc:  # noqa: BLE001
        log.warning("forecast after reset failed: %s", exc)
    log.info("reset water level for %d sites (clear_sky=%s), dropped %d pending predictions",
             n, clear_sky, dropped)
    return {"ok": True, "sites": n, "clear_sky": clear_sky, "dropped_pending": dropped}


@app.get("/correction")
def correction() -> dict:
    svc: ForecastService = STATE["svc"]
    return svc.corrector.state()


@app.post("/retrain")
def retrain(days: int = HISTORY_DAYS) -> dict:
    if STATE.get("retrain") and STATE["retrain"].get("status") == "running":
        raise HTTPException(409, "已有训练任务在跑")

    def _job():
        t0 = time.time()
        STATE["retrain"] = {"status": "running", "started_at": t0}
        try:
            svc: ForecastService = STATE["svc"]
            res = train(STATE["ds_full"], progress=None)
            svc.bundle = load_bundle()
            m = load_metrics()
            m["latest"] = res.to_json()
            save_metrics(m)
            (DATA_DIR / "corrector.json").write_text(
                json.dumps(svc.corrector.state(), ensure_ascii=False), encoding="utf-8")
            STATE["retrain"] = {"status": "done", "version": res.version,
                                "seconds": round(time.time() - t0, 1)}
            log.info("retrain done %s in %.1fs", res.version, time.time() - t0)
        except Exception as exc:
            log.exception("retrain failed")
            STATE["retrain"] = {"status": "failed", "error": str(exc)}

    import threading
    threading.Thread(target=_job, daemon=True).start()
    return {"status": "started"}


@app.get("/retrain/status")
def retrain_status() -> dict:
    return STATE.get("retrain") or {"status": "idle"}


def main() -> None:
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=ENGINE_PORT, log_level="info")


if __name__ == "__main__":
    main()
