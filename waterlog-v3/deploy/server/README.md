# 部署到服务器（阿里云 ECS）

本目录是「把这套系统装到一台 Linux 服务器上」用的一整套东西。**本机开发不用看这里**，
直接 `.\start.ps1` 就行。

## 1. 目标形态

```
        公网
         │  :8200
    ┌────▼─────────────────────────────┐
    │ wl-v3-api.service  (Go, :8200)   │  ← 同时托管前端 dist 与全部 /api
    │   └─ 反代 /api/engine/* ─────────┼──┐
    └──────────────────────────────────┘  │
                                          │ 127.0.0.1:8201（不对外）
                              ┌───────────▼──────────────────┐
                              │ wl-v3-engine.service (Py)    │
                              │   FastAPI + 模拟器 + 预测     │
                              └──────────────────────────────┘
```

**只对外开一个端口。** Go API 自己就带 SPA 静态托管，所以不需要 nginx
（`deploy/nginx.conf` 是另一套容器化方案用的，本机与 ECS 部署都没用它）。

## 2. 目录约定

| 路径 | 内容 |
|---|---|
| `/opt/waterlog-v3/api` | Go 源码 + 编译产物 `waterlog-api` + `data/waterlog.db` |
| `/opt/waterlog-v3/engine` | Python 源码 + `.venv` + `data/`（模型、数据集、仿真状态） |
| `/opt/waterlog-v3/web/dist` | 前端构建产物（由 Go 托管） |
| `/opt/waterlog-v3/logs` | `engine.log` / `api.log`（systemd 追加写） |
| `/opt/waterlog-v3/deploy` | 本目录的脚本与单元文件 |

## 3. 部署三步

```bash
# ① 本机打包（产物在 waterlog-v3/dist-deploy/）
bash deploy/server/build-payload.sh

# ② 传到服务器（任选一种）
#    a) 已经能 SSH：直接 scp
#    b) 只有云助手/控制台：用 serve-upload.sh 临时开个上传口（见 §5）
#    c) 阿里云控制台 Workbench 的「上传文件」按钮

# ③ 服务器上解包并安装
mkdir -p /opt/waterlog-v3
tar -xzf waterlog-v3-payload.tar.gz -C /opt/waterlog-v3 --strip-components=1
bash /opt/waterlog-v3/deploy/install.sh
```

`install.sh` 会：建 venv → 装 Python 依赖 → `go build` → 装两个 systemd 单元 →
先起引擎并轮询 `/health` 就绪 → 再起 API → 打一遍健康检查。

## 4. 运维命令

```bash
systemctl status wl-v3-engine wl-v3-api     # 状态
systemctl restart wl-v3-api                 # 重启 API
journalctl -u wl-v3-api -n 50 --no-pager    # 看日志（单元里也 append 到 logs/）
tail -f /opt/waterlog-v3/logs/engine.log    # 引擎日志
ss -tlnp | grep -E '8200|8201'              # 端口
curl -s http://127.0.0.1:8200/api/health    # 健康检查（含引擎连通性）
```

改了代码重新部署：只改前端 → 本机 `npm run build` 后只传 `web/dist`；
只改 Go → 只传 `api/` 再 `systemctl restart wl-v3-api`；
只改 Python → 只传 `engine/waterlog/` 再 `systemctl restart wl-v3-engine`。

## 5. 没有 SSH 时怎么传文件

ECS 只开了 22 且没配好密钥时，有两条路：

**a) 阿里云云助手**（`aliyun ecs RunCommand`）：适合跑命令，不适合传大文件 ——
单条命令 base64 后上限 24KB，5MB 的包要上千次往返。

**b) 临时上传口**（本项目用的就是这个）：

```bash
# 服务器：把 serve-upload.sh 贴上去（几 KB，云助手一次就能传），然后起服务
setsid nohup bash /root/serve-upload.sh 8299 <随机令牌> > /root/upload.log 2>&1 &
# 安全组临时放行 8299（只放自己的出口 IP 最稳；ECS 控制台或 CLI 都行）
# 本机：PUT 上去，传完让服务自杀
curl -T dist-deploy/waterlog-v3-payload.tar.gz -H "X-Token: <随机令牌>" \
     http://<公网IP>:8299/waterlog-v3-payload.tar.gz
curl -X POST -H "X-Token: <随机令牌>" http://<公网IP>:8299/__DONE__
# 收尾：立刻删掉安全组规则
```

传完一定要 **`md5sum` 比对**，再删安全组规则。

## 6. 踩过的坑（都写进代码注释了）

| 现象 | 根因 | 处理 |
|---|---|---|
| 引擎起不来，`ModuleNotFoundError: No module named '_loss'` | 本机训练用的 scikit-learn 1.8.0，服务器上装的是 1.5.2；pickle 里记着私有模块名，跨大版本加载不了 | **依赖按训练时的版本钉死**：`scikit-learn==1.8.0`、`numpy==2.3.5`、`joblib==1.5.3`。模型是 pickle，不是跨版本格式 |
| 服务器上 `curl 127.0.0.1:8200` 通，公网连不上 | Go API 默认绑 `127.0.0.1`（本机开发不需要对外） | 新增 `WL_API_HOST`，默认仍 `127.0.0.1`，systemd 单元里显式设 `0.0.0.0` |
| `cp engine/data/models/vXXXX` 报 cannot stat | `latest.txt` 里存的是版本号，磁盘上的文件名带 `.joblib` | 打包脚本拼后缀 |
| 本机 `bash build-payload.sh` 报 `rsync: command not found` | Windows 的 Git Bash 不带 rsync | 改用 `tar` 管道复制 |
| 安全组放了 8299，本机仍连不上 | 放行时 `SourceCidrIp` 写成了单个 IP 但规则没生效（地域/网卡类型不匹配） | 用 `DescribeSecurityGroupAttribute --NicType intranet` 回读确认规则真的存在 |
