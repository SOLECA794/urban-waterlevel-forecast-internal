# waterlog-v3 服务器交接说明

> 本文件描述**服务器上的部署现状**与**接手改动的方式**。改动前请先读第 3 节的纪律，
> 里面几条都是踩过的坑（尤其是「模型是 pickle，不跨 sklearn 大版本」）。

---

## 1. 线上现状

| 项目 | 值 |
|---|---|
| 访问地址 | **http://114.55.31.135:8200** |
| 大屏 | http://114.55.31.135:8200/board |
| 账号 | `admin` / `admin123` |
| 服务器 | 阿里云 ECS `114.55.31.135`（`i-bp14x7n5r7pxvmedxx57`，cn-hangzhou，2 vCPU / 1.9 GB 内存） |
| 对外端口 | **仅 8200**（Go API 自带 SPA 托管，不需要 nginx） |
| 内部端口 | 引擎 8201，只绑 `127.0.0.1` |
| 进程管理 | systemd，两个 unit：`wl-v3-engine.service` → `wl-v3-api.service` |

**占用端口提醒**：这台机器上 `8095/8099/8100/8101/8102/8104/6379` 是**别的项目**在用，不要动。
`/opt/waterlog` 是旧版（另一个 systemd 服务 `waterlog.service`），也不要在本次交接中改动。

---

## 2. 服务器上的三个目录

| 路径 | 内容 | 说明 |
|---|---|---|
| `/opt/waterlog-v3` | **运行版**（339 MB） | 含 `.venv`、模型、数据集，直接跑服务。**改代码要改这里再重启** |
| `/opt/waterlog-v3-src` | **源码交接包**（1.9 MB） | 完整源码树，供参考/对照/重建，**不带依赖与大二进制** |
| `/opt/waterlog-v3.bak-20261109-184321` | 上一版备份（83 MB） | 回滚用 |

`/opt/waterlog-v3-src/waterlog-v3/` 里的目录结构与本地仓库一致：
`api/ engine/ web/ scripts/ docs/ deploy/ start.ps1 README.md Makefile docker-compose.yml`。

---

## 3. 改代码并上线的流程

### 3.1 只改前端
```bash
# 本地
cd web && npm install && npm run build        # 产出 web/dist/assets/index-*.js
# 把 web/dist 传到服务器（见 3.3），然后：
systemctl restart wl-v3-api        # SPA 是 Go 内嵌托管，重启即可生效
```

### 3.2 改后端 / 引擎
```bash
# Go（api/）
cd /opt/waterlog-v3/api
export GOPROXY=https://goproxy.cn,direct GOMAXPROCS=2
/usr/local/go/bin/go build -trimpath -ldflags "-s -w" -o waterlog-api ./cmd/waterlog-api
systemctl restart wl-v3-api

# Python（engine/）
systemctl restart wl-v3-engine
```

### 3.3 传文件（**这台机器没有 SSH 密钥，只能用云助手或临时开端口**）
```bash
# 方式 A：云助手跑命令（适合小改动用 sed/python 就地改）
bash .workbuddy/ops/aliyun-run.sh '<命令>' <任务名> <超时秒>

# 方式 B：临时开 8299 口直传（适合传文件，几 MB 秒级完成）
#   1) 安全组放行 TCP 8299（0.0.0.0/0，注意要 0.0.0.0/0，按本机 IP/32 实测不通）
#   2) 服务器上跑 deploy/server/serve-upload.sh 8299 <令牌>
#   3) curl -X PUT -H "X-Token: <令牌>" --data-binary @文件 http://114.55.31.135:8299/文件名
#   4) curl -X POST -H "X-Token: <令牌>" http://114.55.31.135:8299/__DONE__
#   5) 用完立刻撤销安全组规则
```

### 3.4 打包脚本
- `deploy/server/build-payload.sh` —— **运行包**（web/dist + 模型 + 数据集 + 源码），用于部署
- `deploy/server/build-source.sh` —— **源码包**（含 web/src、docs、scripts，不含依赖），用于交接
- `deploy/server/install.sh` —— 首次安装（建 venv、装依赖、编译、装 unit、按序启动）

---

## 4. 必须知道的几条纪律

### 4.1 模型是 pickle，依赖不能随便升
`engine/requirements.txt` 里这三个是**精确锁版本**的：
```
numpy==2.3.5
scikit-learn==1.8.0
joblib==1.5.3
```
原因：训练产物 `engine/data/models/v20261021-050212.joblib` 是 pickle，反序列化要 import
训练时的私有模块（sklearn 的 `_loss`）。服务器上曾装到 sklearn 1.9.1，启动即报
`ModuleNotFoundError: No module named '_loss'`。**升级这三个包必须连模型一起重训。**

### 4.2 引擎必须先起，API 后起
`wl-v3-api.service` 里写了 `Wants=wl-v3-engine.service`，但实测首次冷启动时 API 会在引擎
就绪前发请求。`install.sh` 里的顺序是先轮询 `/health` 再起 API，手工重启时也建议照做。

### 4.3 留两份截图证据
改完大屏后建议存一张截图对照：
```bash
node scripts/shoot-board.mjs --base http://114.55.31.135:8200 --themes light --scenes 0 --wait 6000
node scripts/acceptance.ps1 -Base http://114.55.31.135:8200 -SkipStorm   # 期望 PASS 59 / FAIL 0
```

---

## 5. 已知问题（未修）

1. **暴雨注入接口在引擎长跑后失效**：`POST /api/sim/storm` 返回 ok 但雨量恒为 0，
   重启引擎即恢复。怀疑 `engine/waterlog/domain/hydrology.py` 的 `RainProcess._generated`
   与 `rain[]` 实际长度在 `load_state` 之后失配。已如实写进 `docs/02-验收报告.md` §5.3。
   **该接口不参与大屏与主界面的数据链路**，只影响演示时注雨。
2. **`/api/alerts` 有仿真时钟回拨前写入的历史行**（90 条里只有 35 条时间戳合理）。
   前端已加护栏（只统计 `0 < 段长 ≤ 720 分钟`）并在卡片上如实标注剔除条数。
3. **页面视觉仍在调整中**（用户 m31102 的评价是「页面设计的还是不太好」），
   接手者可以继续在 `web/src/board/` 下改。改版面务必先跑
   `python _tools/board_layout.py verify`（校验三套预设不重叠、不越界、间隙一致）。
