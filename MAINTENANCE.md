# 维护手册：每周版本对齐 · VPS 更新 · 首次部署

本仓库是 Command Code CLI 私有协议 → OpenAI/Anthropic 兼容接口的无依赖 Node.js 代理。协议实现以**本机安装的 command-code CLI bundle** 为基线，基线版本记录在 `config.json` 的 `protocolVersion`，同时作为 `x-command-code-version` 请求头发给上游。

本文包含三部分：

1. [每周版本对齐](#1-每周版本对齐) —— 一段可直接复制给 AI 助手的提示词
2. [已部署 VPS 的更新流程](#2-已部署-vps-的更新流程)
3. [首次部署](#3-首次部署)

建议节奏：每周固定一天（例如周五）执行一次第 1 节的提示词；CLI 无新版时整个过程不到一分钟。

---

## 1. 每周版本对齐

### 1.1 手动快速判断（10 秒）

```bash
cmdc --version          # 本机最新 CLI 版本
grep protocolVersion config.json
```

两者一致就不需要做任何事；不一致才需要执行下面的提示词。

### 1.2 每周更新提示词

> 在仓库根目录打开 ZCode/Claude Code 等 AI 会话，整段复制以下内容发送即可。提示词自包含，不依赖本次会话的上下文。

```text
你是本仓库（commandcode-proxy）的维护助手。本仓库把 Command Code CLI 的私有协议转换为
OpenAI/Anthropic 兼容接口，零外部依赖（Node.js ESM，Node >= 22）。协议实现固定以本机安装的
command-code CLI bundle 为基线，基线版本记录在 config.json 的 protocolVersion，同时作为
x-command-code-version 头发给上游。

本次任务：检查本机 command-code CLI 是否发布新版本；如有，把代理协议对齐到新版本；没有则
直接报告"无需更新"并停止。

## 第一步：确认版本
1. 运行 `cmdc --version` 获取本机 CLI 版本；
2. 读取 config.json 的 protocolVersion；
3. 两者一致 → 无需更新，结束；不一致 → 继续。

## 第二步：定位 CLI bundle 并读取变更
1. bundle 位置：`npm root -g` 输出目录下的 command-code/dist/cli.mjs
   （Windows nvm4w 通常在 C:\nvm4w\nodejs\node_modules\command-code\dist\cli.mjs）；
2. npm 包自带 CHANGELOG.md，先通读旧基线到新版本之间的条目，标记协议相关变更
   （请求头、信封字段、指纹算法、流事件、端点、默认值、mode 白名单）。

## 第三步：按清单核对 bundle（代码是 minified 的，用 __name(压缩名,"原名") 反查函数定义；
不要依赖上一次的压缩变量名——它们每个版本都会变，要搜字符串常量锚点）
1. 请求头：搜 `buildCommandAuthHeaders` —— 头集合、恒定头/可选头规则
   （对应 src/cc-client.mjs 的 buildCommandCodeHeaders）；
2. 生成信封：搜 `/alpha/generate` —— 顶层键 config/memory/taste/skills/permissionMode/
   threadId/mode/params 的有无与键序；params 内 model/messages/tools/system/max_tokens/
   stream/temperature/reasoning_effort 的键序与附加条件
   （对应 src/adapters.mjs 的 buildCcRequest）；
3. wire 消息转换：搜 toWireMessages / toWireTools / toWireToolName / toWireToolOutput /
   toWirePermissionMode / toWireThreadId
   （对应 src/adapters.mjs 的 buildWireMessages、toWireTools、normalizePermissionMode）；
4. 设备指纹：搜 `buildMachineFingerprint` 和 `command-code:device-fingerprint:v1` ——
   盐值、hashSignal 规则、thumbmark 拼接公式、components 字段顺序
   （对应 src/fingerprint.mjs 的 generateFingerprint）；
5. 流事件：搜 `consumeStream` —— 处理的事件类型集合、finish 事件的
   totalUsage/rawFinishReason/systemPromptTokens 等字段
   （对应 proxy.mjs 的 createSseTranslator、src/adapters.mjs 的 createAnthropicSseTranslator）；
6. 会话初始化：搜 `cli_session_exists`、`/alpha/lifecycle-events`、`/alpha/fingerprint/record`
   —— 载荷形状（对应 proxy.mjs 的 ensureInitialized）；
7. 默认值与白名单：搜 `deepseek/` 模型常量、max_tokens 默认值（形如 64e3）、reasoning 档位
   数组（low/medium/high/xhigh/max）、permissionMode 取值、modelClient 用途键
   （对应 src/config.mjs 的 VALID_CC_MODES、src/adapters.mjs 的默认值）；
8. pause_turn 续传上限：搜 `pause_turn` 附近的循环重试计数
   （对应 proxy.mjs 中 continuationCount < N 的四处判断）。

## 第四步：更新代码、测试与文档
1. 只改有差异的项，不要无差别重构；所有改动补充中文注释，注明"对齐 command-code@新版本"；
2. 更新 config.json 与 src/config.mjs 中的 protocolVersion 默认值；
3. 同步更新 test/ 下的相关断言，以及 README.md、README_zh.md 里出现的旧基线版本号和差异描述；
4. 若某项无法从 bundle 静态确认（例如服务端新增事件类型），用抓包验证：设置
   RECORD_WIRE=captured-requests/wire-新版本.jsonl 后把真实 CLI 指向代理跑一次
   （CLI 侧 COMMANDCODE_API_ENV=local），比对 wire 形状后再实现。

## 第五步：验证与提交
1. `npm run check` 必须通过；
2. `npm test` 必须全绿（58 项左右，含集成测试；数量随版本可能增加）；
3. 按 Conventional Commits 提交，例如
   `feat: align proxy protocol with command-code@X.Y.Z`，并推送到 origin/master，
   便于 VPS 侧拉取更新。
```

### 1.3 提示词之外的两个人工检查点

- **CHANGELOG 速查**：npm 包内自带 `CHANGELOG.md`（`C:\nvm4w\nodejs\node_modules\command-code\CHANGELOG.md`），从旧基线读到新版本，通常 5 分钟能判断本次是否涉及协议变更。纯 UI/工具类更新不需要动代理。
- **抓包兜底**：bundle 是 minified 的，遇到"不确定服务端行为"的场景（新事件类型、新头），用 `RECORD_WIRE` 走一次真实流量最可靠。README_zh.md 的"反检测"章节和 proxy.mjs 头部注释有说明。

---

## 2. 已部署 VPS 的更新流程

前置说明：本仓库**零 npm 依赖**，`git pull` 之后不需要 `npm install`。更新总是"拉代码 → 本地验证 → 重启进程"三步。代理监听 `0.0.0.0:3050`（可用 `PORT`/`PROXY_PORT` 改）。

### 2.1 方式 A：裸 Node 部署（pm2 托管）

```bash
cd /opt/commandcode-proxy
git pull origin master
npm run check && npm test        # 必须全绿再重启
pm2 restart commandcode-proxy
pm2 logs commandcode-proxy --lines 30
```

### 2.2 方式 A：裸 Node 部署（systemd 托管）

```bash
cd /opt/commandcode-proxy
git pull origin master
npm run check && npm test
systemctl restart commandcode-proxy
journalctl -u commandcode-proxy -n 30 --no-pager
```

systemd 参考单元（`/etc/systemd/system/commandcode-proxy.service`）：

```ini
[Unit]
Description=CommandCode Proxy
After=network.target

[Service]
WorkingDirectory=/opt/commandcode-proxy
ExecStart=/usr/bin/node proxy.mjs
Environment=PORT=3050
Environment=LOG_FILE=/var/log/commandcode-proxy/proxy.log
Restart=always
RestartSec=3
User=www-data

[Install]
WantedBy=multi-user.target
```

`LOG_FILE` 目录需要预先创建并授权给运行用户，否则代理会自动降级为仅控制台日志。

### 2.3 方式 B：Docker Compose 部署

```bash
cd /opt/commandcode-proxy
git pull origin master
docker compose up -d --build     # 镜像从本地源码构建，必须带 --build
docker compose logs -f --tail 100 proxy
```

自定义主机端口时：`PROXY_PORT=13050 docker compose up -d --build`。

### 2.4 更新后验证（三种方式通用）

```bash
# 1. 健康检查
curl http://127.0.0.1:3050/health            # 应返回 OK

# 2. 确认版本基线已生效（应输出新版本号）
grep protocolVersion config.json

# 3. 模型列表走通（匿名可访问）
curl -s http://127.0.0.1:3050/v1/models | head -c 300

# 4. 用真实 Key 跑一条最小生成请求
curl -s http://127.0.0.1:3050/v1/chat/completions \
  -H "Authorization: Bearer user_xxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}],"max_tokens":16}'
```

日志层面确认两点：没有 `Fingerprint record failed`（指纹上报被拒，说明指纹算法与新后端不匹配），也没有持续刷 `Unknown CC event type`（说明上游新增了代理未识别的事件，需要回到第 1 节重新对齐）。

### 2.5 回滚

```bash
git log --oneline -5                 # 找到上一个可用提交
git checkout <commit>                # 或 git checkout <tag>
# Node：pm2 restart commandcode-proxy / systemctl restart commandcode-proxy
# Docker：docker compose up -d --build
```

---

## 3. 首次部署

### 3.1 前置要求

| 项目 | 要求 |
|------|------|
| Node.js | ≥ 22.0（`package.json` engines 约束；Docker 镜像基于 node:22-alpine） |
| 磁盘/内存 | 极低：零 npm 依赖，无需 `npm install` |
| 网络 | 能访问 `https://api.commandcode.ai`（默认上游） |
| Command Code Key | 形如 `user_xxx`，**只通过请求头传递，绝不写入 config.json 或日志** |

### 3.2 方式 A：裸 Node + pm2（推荐常规 VPS）

```bash
# 安装 Node 22（Ubuntu/Debian，NodeSource）；
# 已有 Node 22 可跳过
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 克隆并前台试跑
git clone https://github.com/riyan6/commandcode-proxy.git /opt/commandcode-proxy
cd /opt/commandcode-proxy
npm start                            # 看到 "CC Proxy started" 即正常，Ctrl+C 退出

# pm2 托管
sudo npm i -g pm2
pm2 start proxy.mjs --name commandcode-proxy
pm2 save && pm2 startup              # 开机自启
```

### 3.3 方式 B：Docker Compose（推荐免维护）

```bash
git clone https://github.com/riyan6/commandcode-proxy.git /opt/commandcode-proxy
cd /opt/commandcode-proxy
PROXY_PORT=3050 docker compose up -d --build
docker compose ps                    # 等待 healthy
```

镜像内置健康检查（30s 间隔探测 `/health`），`docker compose ps` 显示 `healthy` 即就绪。

### 3.4 配置要点

配置优先级：环境变量 > `config.json` > 内置默认。常用项（完整表见 README_zh.md）：

| 配置 | 默认 | 说明 |
|------|------|------|
| `PORT` / `port` | `3050` | 监听端口 |
| `HOST` / `host` | `0.0.0.0` | 监听地址 |
| `apiBase` | `https://api.commandcode.ai` | 上游地址，一般不需要改 |
| `protocolVersion` | `1.47.0` | 协议基线 = `x-command-code-version` 头，随每周对齐更新 |
| `mode` | `agent` | 请求模式（agent/learning/title-gen 等，白名单见 src/config.mjs） |
| `permissionMode` | `standard` | 权限模式 |
| `LOG_FILE` | 空 | 设为文件路径后开启落盘日志 |
| `LOG_LEVEL` | `info` | debug 可打印请求结构（不含正文和 Key） |
| `RECORD_WIRE` | 空 | 抓包记录文件（脱敏），排查协议问题时使用 |

API Key 的用法：客户端每次请求带 `Authorization: Bearer user_xxx`（Anthropic 客户端也兼容 `x-api-key` 头）。**一个 Key 一个会话与指纹**，多 Key 分开使用互不影响。

### 3.5 安全与对外暴露

- 防火墙只放行必要端口；生产建议在前面挂 nginx/Caddy 反代 + TLS，代理只监听 `127.0.0.1`（`HOST=127.0.0.1`）。
- 除 `/health`、`/`、`/v1/models`、`/dashboard` 外，所有路径（含原生透传 `/alpha/*` 等）都要求 Authorization 头，不带 Key 的请求一律 401。
- 流式响应依赖禁用缓冲：nginx 需 `proxy_buffering off;`（或依赖代理发送的 `X-Accel-Buffering: no`）；Caddy 默认即可。
- 原生透传入口（`/alpha/*`、`/beta/*`、`/internal/*`、`/provider/*`）会透传 Cookie/OAuth 头，生产环境建议给它用**独立域名**，避免与其他 Web 应用共享 Cookie 边界（README_zh.md 有详细说明）。
- 调试日志可能包含请求结构，切勿把日志目录公开；日志中不应出现 API Key（代码已做脱敏，改动日志相关代码时保持这一约束）。

### 3.6 部署完成验证

```bash
curl http://127.0.0.1:3050/health
# 应返回 OK；随后用真实 Key 跑一次 2.4 节的最小生成请求，
# 并打开 http://<域名>/dashboard 输入 Key 查看指标是否开始计数。
```

之后每周回到第 1 节做版本对齐即可。
