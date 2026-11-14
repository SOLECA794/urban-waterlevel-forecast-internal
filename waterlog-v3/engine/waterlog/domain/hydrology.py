"""城市内涝水文模拟器。

模型选择：**双面积水库模型**（汇水区 + 积水区），不是随机游走，也不是简单正弦。
理由：内涝的本质是"汇水区产流 > 管网排水 + 漫流出流"，积水在低洼处累积。
双面积模型能把这件事讲清楚，且产生的水位曲线有真实的水文特征：
快速上涨、峰值滞留、指数退水、管网顶托。

物理量：
    runoff  = 降雨量(mm) × 汇水面积 × 不透水率            [m3]
    drain   = 管网排水能力(mm/h) × 汇水面积 × 时长 × 效率   [m3]
    weir    = k × h^1.5 × 时长                              [m3]  漫流/堰流
    Δh      = (runoff - drain - weir) / 积水面积            [m]

假设与局限（答辩时必须说清楚）：
1. 不是 SWMM/MIKE 的率定模型，参数是手工标定的"看起来对"，不用于真实工程决策；
2. 管网按设计能力恒定排水，只用一个效率系数表达淤积/顶托，没有管网拓扑；
3. 降雨是泊松到达 + 高斯型过程线，不是真实气象再分析数据；
4. 站点之间没有水力联系（不考虑上游来水），只有空间降雨差异。

这些局限写在 docs/01-算法链路说明.md 里，不藏。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from waterlog.config import DT_SEC, SITES, STEP_MIN, Site

LOOKAHEAD_STEPS = 12 * 60 // STEP_MIN   # 未来 12h 的雨量预生成，供"气象预报"派生


@dataclass
class Storm:
    start: int
    dur: int
    peak: float          # mm/h
    rise: float = 0.35
    tail: float = 0.45

    def intensity(self, step: int) -> float:
        if step < self.start or step >= self.start + self.dur:
            return 0.0
        p = (step - self.start) / max(self.dur - 1, 1)
        if p < self.rise:
            shape = (p / self.rise) ** 0.8
        else:
            shape = math.exp(-((p - self.rise) / self.tail) ** 2)
        return self.peak * shape


# 清零后保证的干窗口长度（步）：60 步 = 5 小时，足够让水位落回阈值以下
QUIET_STEPS = 60


class RainProcess:
    """城市尺度的降雨过程：泊松到达 + 非对称高斯过程线 + 日变化/月变化调制的到达率。"""

    def __init__(self, rng: np.random.Generator, start_step: int = 0):
        self.rng = rng
        self.storms: list[Storm] = []
        self.next_arrival = start_step + self._gap(start_step)
        self.rain: list[float] = []      # mm/h，每步一个值（城市平均）
        self._generated = 0

    def _gap(self, step: int) -> int:
        # 到达率随月份与时段变化：夏季/午后傍晚更容易起对流
        month = ((step * STEP_MIN) // (60 * 24)) % 12 + 1
        season = {1: 0.25, 2: 0.3, 3: 0.45, 4: 0.6, 5: 0.8, 6: 1.05,
                  7: 1.2, 8: 1.15, 9: 0.8, 10: 0.55, 11: 0.35, 12: 0.28}[month]
        hour = ((step * STEP_MIN) // 60) % 24
        diurnal = 1.55 if 14 <= hour <= 21 else (0.55 if 3 <= hour <= 8 else 1.0)
        rate_per_day = 0.85 * season * diurnal      # 期望暴雨场次/天
        return max(1, int(self.rng.exponential(1.0 / max(rate_per_day, 0.05)) * 24 * 60 / STEP_MIN))

    def _spawn(self, step: int) -> Storm:
        rng = self.rng
        dur = int(np.clip(rng.lognormal(math.log(45), 0.50), 6, 96))       # 30min ~ 8h
        peak = float(np.clip(rng.lognormal(math.log(26), 0.62), 3, 240))   # mm/h
        if rng.random() < 0.07:                                            # 极端场次
            peak *= float(rng.uniform(2.0, 3.4))
        return Storm(step, dur, peak, rise=float(rng.uniform(0.25, 0.45)),
                     tail=float(rng.uniform(0.35, 0.6)))

    def ensure(self, upto: int) -> None:
        """保证 rain[] 至少覆盖到 upto 步（含未来 lookahead）。"""
        while self._generated <= upto:
            s = self._generated
            if s >= self.next_arrival:
                storm = self._spawn(s)
                self.storms.append(storm)
                self.next_arrival = s + self._gap(s)
            total = sum(st.intensity(s) for st in self.storms if st.start + st.dur > s)
            total += 0.6 * max(0.0, math.sin(s / 37.0)) * 0.4   # 微量背景降水
            self.rain.append(total)
            self.storms = [st for st in self.storms if st.start + st.dur > s - 4]
            self._generated += 1

    def window(self, start: int, stop: int) -> np.ndarray:
        self.ensure(stop)
        return np.asarray(self.rain[start:stop], dtype=float)


class Simulator:
    """多站点仿真器：一次推进 n 步，返回 (n, N) 的观测矩阵。"""

    def __init__(self, seed: int = 20261021, start_step: int = 0):
        self.rng = np.random.default_rng(seed)
        self.rain = RainProcess(np.random.default_rng(seed + 1), start_step)
        self.step = start_step
        n = len(SITES)
        # 初始积水深度：给一点基线湿态，避免从 0 起跳
        self.h = self.rng.uniform(0.0, 0.02, size=n)
        self.h = np.clip(self.h, 0, None)
        # 站点空间系数：地形/风向导致的雨量差异，固定 + 缓慢摆动
        self.spatial = np.array([0.86, 1.02, 1.12, 0.94, 1.06, 0.98, 1.15, 0.9, 1.0, 1.08])
        self.spatial = self.spatial[:n]
        # 参数矩阵
        self.A_catch = np.array([s.area_catch_m2 for s in SITES])
        self.A_pond = np.array([s.area_pond_m2 for s in SITES])
        self.imperv = np.array([s.impervious for s in SITES])
        self.drain_cap = np.array([s.drainage_mm_h for s in SITES])
        self.weir_k = np.array([s.weir_k for s in SITES])
        self.backwater = np.array([s.backwater for s in SITES])
        self.base = np.array([s.base_level for s in SITES])
        self.thr = np.array([s.thresholds for s in SITES])   # (N,4)
        # 传感器
        self.sensor_noise = 0.008
        # 最近 3h 雨量（用于顶托强度）
        self._rain_hist: list[np.ndarray] = []

    # ------------------------------------------------------------------ 推进

    def advance(self, n: int = 1) -> dict[str, np.ndarray]:
        self.rain.ensure(self.step + n + LOOKAHEAD_STEPS)
        out = {
            "step": np.zeros(n, dtype=np.int64),
            "rain": np.zeros((n, len(SITES))),
            "level": np.zeros((n, len(SITES))),
            "quality": np.ones((n, len(SITES)), dtype=np.int8),
            "rain_fc_1h": np.zeros((n, len(SITES))),
            "rain_fc_3h": np.zeros((n, len(SITES))),
            "rain_fc_6h": np.zeros((n, len(SITES))),
            "rain_fc_12h": np.zeros((n, len(SITES))),
        }
        for i in range(n):
            s = self.step
            out["step"][i] = s
            rain_h = float(self.rain.rain[s]) if s < len(self.rain.rain) else 0.0
            # 空间差异 + 缓慢摆动（不影响物理，只影响落区）
            wobble = 1.0 + 0.10 * math.sin(s / 53.0)
            rain_site = np.clip(rain_h * self.spatial * wobble, 0.0, None)   # mm/h

            runoff = (rain_site / 1000.0) * (STEP_MIN / 60.0) * self.A_catch * self.imperv
            # 顶托：近 3h 雨量越大，外江/渠水位越高，排水越受阻
            recent = float(np.sum(self._rain_hist[-36:])) if self._rain_hist else 0.0
            bw = np.clip(self.backwater * min(1.0, recent / 45.0), 0.0, 0.85)
            eff = np.clip(1.0 - 0.35 * np.minimum(self.h / 0.40, 1.0), 0.45, 1.0)
            drain = self.drain_cap / 1000.0 * (STEP_MIN / 60.0) * self.A_catch * eff * (1.0 - bw)
            drain = np.minimum(drain, self.h * self.A_pond)          # 不能抽走不存在的水
            weir = self.weir_k * np.power(np.maximum(self.h, 0.0), 1.5) * DT_SEC
            # 漫溢拓宽：水深超过红色阈值后，积水向相邻街区漫溢，等效调蓄面积随水深扩大。
            # 这是让极端暴雨不会算出 3~4m 积水的关键物理约束（真实内涝会被街道调蓄削峰）。
            spill = self.thr[:, 3]
            widen = 1.0 + 6.0 * np.maximum(0.0, self.h - spill) / np.maximum(spill, 0.05)
            area_eff = self.A_pond * widen
            self.h = np.maximum(0.0, self.h + (runoff - drain - weir) / area_eff)

            self._rain_hist.append(rain_site / 1000.0 * STEP_MIN)    # mm/步
            if len(self._rain_hist) > 200:
                self._rain_hist = self._rain_hist[-200:]

            level = self.base + self.h
            # 传感器噪声 + 偶发劣化
            degraded = self.rng.random(len(SITES)) < 0.012
            noise = self.rng.normal(0.0, self.sensor_noise, size=len(SITES))
            level = level + noise
            if i > 0:
                level = np.where(degraded, out["level"][i - 1] + self.rng.normal(0, 0.004, len(SITES)), level)
            out["level"][i] = level
            out["rain"][i] = rain_site
            out["quality"][i] = np.where(degraded, 0, 1)

            # 气象预报：对真实未来雨量加"系统性低估 + 随预见期放大的随机误差"
            for key, k in (("rain_fc_1h", 12), ("rain_fc_3h", 36), ("rain_fc_6h", 72), ("rain_fc_12h", 144)):
                true_sum = float(np.sum(self.rain.window(s + 1, s + 1 + k))) * STEP_MIN / 60.0
                bias = 1.0 - 0.04 * math.sqrt(k / 12.0)
                sigma = 0.10 * math.sqrt(k / 12.0)
                out[key][i] = max(0.0, true_sum * bias * (1.0 + self.rng.normal(0.0, sigma)))
            self.step += 1
        return out

    def inject_storm(self, peak: float = 90.0, dur: int = 24,
                     rise: float = 0.30, tail: float = 0.50) -> Storm:
        """在当前时刻插入一段降雨过程（验收通道用）。

        必须先把已生成的雨量序列从当前步截断重算：ensure() 只在“生成”某一步时
        才累加 storms，已经算好的未来雨量不会因为事后 append 一场雨而改变。
        截断后 _generated 回退到当前步，ensure() 用同一批 storm 重放，
        结果确定且与已有历史完全一致（只有新增的这场雨是差异）。
        """
        self.rain.rain = self.rain.rain[: self.step]
        self.rain._generated = self.step
        st = Storm(self.step + 1, max(2, int(dur)), float(peak), rise, tail)
        self.rain.storms.append(st)
        self.rain.ensure(self.step + LOOKAHEAD_STEPS)
        return st

    def reset_water(self, clear_sky: bool = False) -> int:
        """把所有站点积水清零（视为已完成排水）。

        clear_sky=True 时连天上的雨一起停掉：把已生成的雨量序列截断到当前步、
        清空未发生的暴雨队列，并让下一场雨至少在 QUIET_STEPS 之后才到达。
        这样「清零 → 干窗口 → 预警解除」不会因为天上还在下而反复。

        生产环境不提供该能力；它存在的唯一目的是让预警状态机可被确定性验证。
        """
        self.h = np.zeros_like(self.h)
        if clear_sky:
            self.rain.rain = self.rain.rain[: self.step]
            self.rain._generated = self.step
            self.rain.storms = []
            self.rain.next_arrival = self.step + QUIET_STEPS
            self.rain.ensure(self.step + LOOKAHEAD_STEPS)
        return int(self.h.size)

    # ------------------------------------------------------------------ 状态存取

    def state(self) -> dict:
        return {
            "step": np.int64(self.step),
            "h": self.h,
            "rain_series": np.asarray(self.rain.rain, dtype=np.float64),
            "rain_generated": np.int64(self.rain._generated),
            "next_arrival": np.int64(self.rain.next_arrival),
            "storms": np.asarray([[st.start, st.dur, st.peak, st.rise, st.tail] for st in self.rain.storms], dtype=float),
            "rain_hist": np.asarray(self._rain_hist[-200:], dtype=float),
        }

    def load_state(self, st: dict) -> None:
        self.step = int(st["step"])
        self.h = np.asarray(st["h"], dtype=float)
        self.rain.rain = [float(x) for x in st["rain_series"]]
        self.rain._generated = int(st["rain_generated"])
        self.rain.next_arrival = int(st["next_arrival"])
        arr = np.asarray(st["storms"], dtype=float)
        self.rain.storms = [Storm(int(a[0]), int(a[1]), float(a[2]), float(a[3]), float(a[4])) for a in arr] if arr.size else []
        self._rain_hist = [np.asarray(x, dtype=float) for x in np.asarray(st["rain_hist"], dtype=float)] if np.asarray(st["rain_hist"]).size else []
