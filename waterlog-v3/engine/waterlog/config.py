"""站点参数、阈值、规则默认值、路径常量。

所有"可配置"的东西集中在这里，其他模块只读不写。
站点参数是手工标定的（不是随机生成），保证每个站点的性格可解释：
隧道/涵洞汇水快、排水差、阈值低；公园/湖区汇水慢、调蓄强、阈值高。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

# ---------------------------------------------------------------- 路径

ENGINE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("WL_ENGINE_DATA", ENGINE_DIR / "data"))
DATASET_PATH = DATA_DIR / "dataset.npz"
MODELS_DIR = DATA_DIR / "models"
EVAL_DB_PATH = DATA_DIR / "eval.sqlite"
RULES_PATH = DATA_DIR / "rules.json"
METRICS_PATH = DATA_DIR / "metrics.json"

# ---------------------------------------------------------------- 时间

STEP_MIN = 5                     # 仿真步长（分钟）
STEP_SEC = STEP_MIN * 60
DT_SEC = STEP_SEC
HISTORY_DAYS = 60                # 历史数据天数（训练用）
LIVE_BUFFER_STEPS = 2 * 24 * 60 // STEP_MIN   # 在线缓冲 48h
HORIZONS_MIN = (60, 180, 360, 720)            # 1h / 3h / 6h / 12h
HORIZONS_STEPS = tuple(h // STEP_MIN for h in HORIZONS_MIN)
# 在线缓冲窗口：留够 24h 特征回看 + 12h 前瞻 + 余量
WARMUP_STEPS = 24 * 60 // STEP_MIN + HORIZONS_STEPS[-1] + 48

# ---------------------------------------------------------------- 站点


@dataclass(frozen=True)
class Site:
    id: str
    name: str
    district: str
    lon: float
    lat: float
    base_level: float        # 基准水位（路面/渠底高程，m）
    catchment_ha: float      # 汇水面积（ha）
    pond_ha: float           # 积水（调蓄）面积（ha）
    impervious: float        # 不透水率 0~1
    drainage_mm_h: float     # 管网设计排水能力（mm/h，按汇水面积计）
    weir_k: float            # 漫流出流系数（m3/s per m^1.5）
    backwater: float         # 顶托系数 0~1（越接近 1 越容易被江/渠水位顶托）
    thresholds: tuple[float, float, float, float]  # 蓝/黄/橙/红（相对 base 的积水深度 m）
    kind: str                # tunnel / interchange / park / riverside / industrial / oldtown / plaza / culvert / campus / channel

    @property
    def area_catch_m2(self) -> float:
        return self.catchment_ha * 1e4

    @property
    def area_pond_m2(self) -> float:
        return self.pond_ha * 1e4


SITES: tuple[Site, ...] = (
    Site("S01", "天长北路下穿隧道", "东城街道", 121.2650, 28.6480, 7.85, 95, 16.0, 0.86, 26, 0.03, 0.10,
         (0.05, 0.15, 0.30, 0.45), "tunnel"),
    Site("S02", "东城立交桥下", "东城街道", 121.2830, 28.6420, 6.40, 140, 22.0, 0.78, 30, 0.04, 0.05,
         (0.05, 0.15, 0.30, 0.50), "interchange"),
    Site("S03", "九峰公园西低洼段", "东城街道", 121.2520, 28.6320, 5.20, 110, 26.0, 0.62, 34, 0.05, 0.00,
         (0.08, 0.20, 0.35, 0.55), "park"),
    Site("S04", "永宁江滨江泵站", "西城街道", 121.2350, 28.6520, 4.10, 170, 34.0, 0.72, 40, 0.06, 0.55,
         (0.06, 0.18, 0.32, 0.48), "riverside"),
    Site("S05", "新前模具小镇北闸", "新前街道", 121.2050, 28.6800, 8.90, 210, 30.0, 0.80, 36, 0.05, 0.15,
         (0.05, 0.16, 0.28, 0.42), "industrial"),
    Site("S06", "桥上街老巷口", "西城街道", 121.2450, 28.6600, 9.30, 70, 12.0, 0.74, 24, 0.02, 0.00,
         (0.04, 0.12, 0.25, 0.38), "oldtown"),
    Site("S07", "台州站站前广场", "北城街道", 121.2700, 28.6820, 11.20, 160, 28.0, 0.88, 32, 0.04, 0.00,
         (0.06, 0.18, 0.30, 0.46), "plaza"),
    Site("S08", "西城快速路涵洞", "西城街道", 121.2180, 28.6390, 12.50, 85, 14.0, 0.82, 22, 0.02, 0.00,
         (0.05, 0.14, 0.26, 0.40), "culvert"),
    Site("S09", "黄岩体育馆周边", "南城街道", 121.2600, 28.6200, 15.80, 130, 24.0, 0.70, 38, 0.04, 0.00,
         (0.07, 0.19, 0.33, 0.50), "campus"),
    Site("S10", "南城永丰河排水渠", "南城街道", 121.2800, 28.6080, 3.60, 240, 40.0, 0.55, 45, 0.06, 0.35,
         (0.10, 0.22, 0.38, 0.58), "channel"),
)

SITE_BY_ID = {s.id: s for s in SITES}
SITE_IDS = tuple(s.id for s in SITES)
N_SITES = len(SITES)

# ---------------------------------------------------------------- 规则默认值

DEFAULT_RULES: dict = {
    "version": "rules-1.0",
    "weights": {"peak": 0.45, "duration": 0.35, "trend": 0.20},
    "min_duration_min": {"blue": 20, "yellow": 30, "orange": 45, "red": 60},
    "duration_saturation_min": 180,
    "score_cutoffs": {"blue": 0.22, "yellow": 0.40, "orange": 0.60, "red": 0.78},
    "trend_upgrade_slope": 0.25,      # m/h，超过则升级一级
    "trend_downgrade_slope": -0.15,   # m/h，低于则降级一级
    "trend_score_span": 0.50,         # m/h，趋势因子归一化跨度
    "horizon_min": 180,               # 研判使用的预见期（分钟）
    "min_level_for_alarm": 1,         # 最低报警等级（1=蓝）
}

# ---------------------------------------------------------------- 服务

ENGINE_PORT = int(os.environ.get("WL_ENGINE_PORT", "8201"))
GO_API_URL = os.environ.get("WL_GO_API", "http://127.0.0.1:8200")
PUSH_ENABLED = os.environ.get("WL_ENGINE_PUSH", "1") == "1"
TICK_SEC = float(os.environ.get("WL_TICK_SEC", "5"))          # 每 tick 推进 1 个仿真步
FORECAST_EVERY_SEC = float(os.environ.get("WL_FORECAST_EVERY_SEC", "60"))
SIM_SEED = int(os.environ.get("WL_SIM_SEED", "20261021"))

# ---------------------------------------------------------------- 天气旋钮
#
# 默认值不是「最真实」，是「演示时屏幕上一直在动」。
# 真实黄岩的暴雨频率大约是 0.85 场/天，按 60 倍速折算约半小时墙钟一场，
# 中间十站读数一动不动 —— 对值班来说那是正常，对演示来说那是坏了。
# 这三个量只影响「下多少雨」，不动物理参数，所以历史数据集与模型不受影响。

RAIN_RATE_SCALE = float(os.environ.get("WL_RAIN_RATE_SCALE", "7.0"))   # 到达率倍数
RAIN_PEAK_SCALE = float(os.environ.get("WL_RAIN_PEAK_SCALE", "1.6"))  # 场次峰值倍数
RAIN_BG_MM = float(os.environ.get("WL_RAIN_BG_MM", "2.2"))             # 背景雨幅度（mm/h）
# 短时阵雨（cells）：2~8 步（10~40 分钟）的小尺度对流，峰值 3~16mm/h。
# 它不制造内涝（低于管网排水能力，深度只抖一抖），但它让「雨强/综合分/趋势」
# 每一帧都在变——否则打开页面看到一排不动的小数，会以为数据源死了。
# 频率单位是「场/仿真日」，按 60 倍速折算约 1.5 分钟墙钟一场。
RAIN_DRIZZLE_PER_DAY = float(os.environ.get("WL_RAIN_DRIZZLE_PER_DAY", "16"))

