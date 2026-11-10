# waterlog-v3 交付说明

> 本文件说明**这份代码在哪里、有几份、彼此什么关系**，以及**接手时从哪里开始**。
> 关于服务器上的部署细节与改造流程，另见 `deploy/server/SERVER-HANDOFF.md`。

---

## 一、代码现在有哪几份

同一套代码，当前存在 **4 个位置**，它们的定位不同，不是同步关系：

| 位置 | 是什么 | 文件数 | 用途 |
|---|---|---|---|
| `D:\Desktop\waterLevelForcasting\waterlog-v3\` | **本地工作区**（开发主体） | 196 个受版本控制 | 在这里改代码 |
| GitHub `SOLECA794/urban-waterlevel-forecast-internal` | **源码仓库**（private） | 196 | 版本管理、备份、协作 |
| 服务器 `/opt/waterlog-v3-src/waterlog-v3/` | **源码交接包**（private 镜像外的离线副本） | 190 | 给拿不到 GitHub 的人看源码 |
| 服务器 `/opt/waterlog-v3/` | **运行版**（正在跑的服务） | 339 MB | 改完要重启的就是它 |

**这三处源码内容一致**，差异只在有意排除的目录（见第三节）。

---

## 二、GitHub 仓库

| 仓库 | 可见性 | 说明 |
|---|---|---|
| `SOLECA794/urban-waterlevel-forecast-internal` | **private** | 当前主仓库，`waterlog-v3` 推在这里 |
| `SOLECA794/urban-waterlevel-forecast` | **private** | 早期仓库（含 `backend/`、`frontend/`、`docs/`、`sdd/`），原先公开，已改为私有 |

**本地 remote 配置**（URL 里**不再内嵌 token**，认证走 `gh` CLI 的 credential helper）：

```bash
internal  https://github.com/SOLECA794/urban-waterlevel-forecast-internal.git   # 本地 main 的 upstream
origin    https://github.com/SOLECA794/urban-waterlevel-forecast.git
```

**推送前先确认认证可用**：

```bash
gh auth status          # 应显示 Logged in to github.com account SOLECA794，scopes 含 repo
gh auth setup-git       # 若 git 报认证失败，重新把 gh 接进 credential helper
git push internal main
```

> **历史教训**：原先 remote URL 里内嵌了一个 PAT（`ghp_ytjQ…`），该 token 已失效，
> 导致 `git ls-remote` 报 `fatal: expected flush after ref listing`、
> `git push` 报 `Invalid username or token`。后来改用 `gh` CLI 的有效凭据。
> **不要把 token 写回 remote URL。**

**本次纳入的 5 个提交**：

```
5e486234  fix: 补回被 data/ 规则误伤的 web/src/data 前端数据层
0e0fa1de  chore: 移除 deploy/dist-deploy 下误入的构建产物
7b81e3cd  chore: dist-deploy 打包产物不进版本库
fe52f0c3  feat: 纳入 waterlog-v3 完整源码（城市内涝水位预测预警系统 v3）
```
（分两次推送：`fe52f0c3` + `7b81e3cd`，随后 `0e0fa1de` + `5e486234`）

---

## 三、有意排除的内容

GitHub 上的 `waterlog-v3` 是**源码**，以下内容按设计不入库（都能重新生成）：

| 排除项 | 原因 | 如何重建 |
|---|---|---|
| `engine/data/*.npz`、`*.joblib`、`*.sqlite` | 数据集、模型、评估库共约 87 MB | `python -m waterlog.cli.bootstrap` |
| `web/node_modules/`、`web/dist/` | 依赖与构建产物 | `npm install && npm run build` |
| `api/waterlog-api.exe`、`api/waterlog-api` | Go 编译产物，平台相关 | `go build ./cmd/waterlog-api` |
| `api/data/`、`logs/` | 运行期数据库与日志 | 服务启动时自动创建 |
| `shots/*.png`（主目录） | 截图（`shots/prod/` 十页线上截图**保留**） | `node scripts/shoot.mjs` |
| `_tools/`、`_stage/`、`_tmp/` | 本地辅助脚本与临时文件 | 不需要 |
| `dist-deploy/`、`deploy/dist-deploy/` | 打包产物（含模型，MB 级） | `deploy/server/build-*.sh` |

**所以 GitHub 上是 196 个文件，服务器源码包是 190 个** —— 差的 6 个是 `_tools/`（2 个）和 `shots/`（4 个），不是漏传。

---

## 四、本轮修掉的两个 `.gitignore` 缺陷

这两个都是**规则写得过宽**，导致该进的没进来：

### 1. `docs/` 连带忽略了子项目文档

```gitignore
docs/           # 裸写 → 在任意层级生效
```

后果：`waterlog-v3/docs/`（14 个文件：算法链路、验收报告、架构说明、ADR、配色方案）**全部没进版本库**。

修正：`docs/` → **`/docs/`**（只锚定仓库根目录）。

### 2. `data/` 连带忽略了前端数据层源码 ← **这个更严重**

```gitignore
data/           # 裸写 → 在任意层级生效
```

后果：`waterlog-v3/web/src/data/` 被忽略，**缺了 `dto.ts`、`adapters.ts`、`client.ts`、`queries.ts`、`live.ts`** 这 5 个文件 —— 它们是前端五层架构里的数据层，**缺了前端根本编译不过**。

修正：

```gitignore
/data/            # 只锚定仓库根
/backend/data/    # 运行期数据库（app.db 等）精确排除
```

> **这个缺陷是被「三方比对」发现的**：服务器源码包走文件系统打包、不经过 gitignore，
> 所以它比 GitHub 上多了这 5 个文件 —— 两边文件数不一致，暴露了问题。
> 单纯「`git status` 干净」是发现不了的。

补回后已重新推送并逐字节验证。

---

## 五、当前线上状态

| 项 | 值 |
|---|---|
| 地址 | **http://114.55.31.135:8200** |
| 大屏 | http://114.55.31.135:8200/board |
| 账号 | `admin` / `admin123` |
| 前端产物 | `index-CmRHwatg.js`（本地与服务器 md5 一致：`9ad27a71…`） |
| 回归 | `scripts/acceptance.ps1 -SkipStorm` → **PASS 59 / FAIL 0** |

线上跑的**就是本轮代码**（冷蓝配色 + 地图降为组件 + 22 个可拖拽组件 + 去白与色调分化）。

---

## 六、接手从这里开始

1. **先读** `deploy/server/SERVER-HANDOFF.md` —— 里面写了改代码 → 上线的完整流程、
   怎么在没有 SSH 密钥的情况下传文件、以及三条不能违反的纪律。
2. **最重要的一条纪律**：`engine/requirements.txt` 里
   `numpy==2.3.5` / `scikit-learn==1.8.0` / `joblib==1.5.3` 是**精确锁版本**的，
   因为模型 `.joblib` 是 pickle、反序列化要 import 训练时的私有模块（sklearn 的 `_loss`）。
   **升级这三个包必须连模型一起重训。**
3. **改版面之前先跑** `python _tools/board_layout.py verify` —— 校验三套预设
   （BALANCED / MAP_FIRST / INFO_FIRST）不重叠、不越界、间隙一致。

### 已知未修问题（如实记录，非隐瞒）

1. **暴雨注入接口在引擎长跑后失效** —— `POST /api/sim/storm` 返回 ok 但雨量恒为 0，
   重启引擎即恢复。怀疑 `engine/waterlog/domain/hydrology.py` 的
   `RainProcess._generated` 与 `rain[]` 实际长度在 `load_state` 之后失配。
   详见 `docs/02-验收报告.md` §5.3。**该接口不参与大屏与主界面数据链路**，
   只影响演示时注雨。
2. **`/api/alerts` 有仿真时钟回拨前写入的历史行** —— 90 条里只有 35 条时间戳合理。
   前端已加护栏（只统计 `0 < 段长 ≤ 720 分钟`）并在卡片上如实标注剔除条数。
3. **页面视觉仍在调整中** —— 最后一轮评审意见是「页面设计的还是不太好」。
   改大屏相关代码集中在 `web/src/board/`（`BoardPage.tsx` 承载 22 个组件，
   `layout.ts` 管版面坐标，`theme.ts` 管配色，`parts.tsx` 管卡片样式）。
4. **`backend/data/` 里有历史提交进来的数据库** ——
   `backend/data/app.db`（5.8 MB）、`app.log` 等 17 个文件在早期提交（`ad9f5736`）
   就被追踪了，本次未清理。若其中有真实数据，建议单独处理。
