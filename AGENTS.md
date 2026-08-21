# Repository Guidelines

## 项目结构与模块组织

这是一个无外部依赖的 Node.js ESM 代理服务。`proxy.mjs` 负责路由和请求编排；`src/` 存放配置、状态、校验、协议适配和上游客户端模块；`test/` 存放 Node 内置测试；`config.json`、`Dockerfile` 与 `docker-compose.yml` 用于配置和部署；`README.md` 与 `README_zh.md` 是接口文档。

## 构建、测试与开发命令

- `npm start`：按配置启动代理，默认监听 `0.0.0.0:3050`。
- `npm run dev`：使用 Node watch 模式启动，适合本地修改后自动重启。
- `npm run check`：检查入口文件语法。
- `npm test`：运行健康检查、认证、协议转换、流式和状态隔离测试。
- `npm run docker:build`：构建当前平台的 Docker 镜像。
- `npm run docker:build:multi`：构建 `linux/amd64` 与 `linux/arm64` 多架构镜像。
- `docker compose up -d`：后台启动容器；可用 `PROXY_PORT=13050` 修改主机端口。

提交前至少运行 `npm run check` 和 `npm test`；需要联调时，再用 `curl http://127.0.0.1:3050/health` 检查健康接口，并使用测试 Key 验证 `/v1/models` 及相关流式/非流式接口。

## 编码风格与命名约定

遵循现有 ESM 风格：2 个空格缩进、单引号、语句末尾使用分号，优先使用 `const`。变量和函数使用 `camelCase`，常量使用全大写下划线。协议字段和请求转换应以本地 `command-code@1.31.0` bundle 为基线；发送给上游的 CLI 版本头允许跟随 npm latest。新增或修改代码必须补充清晰的中文注释。目前没有配置 ESLint 或格式化工具，提交前请保持手工格式一致。

## 提交与拉取请求

近期历史遵循 Conventional Commits，例如 `feat: ...`、`fix(proxy): ...`，提交标题使用祈使式并简洁说明影响。PR 应说明问题、方案、配置或 API 行为变化，并列出实际验证命令及结果；涉及接口、SSE 或 Docker 行为时，应附请求示例或日志片段（脱敏后）。

## 安全与配置注意事项

不要把 API Key 写入 `config.json`、提交记录或日志；按 README 使用 `Authorization` 头或环境变量。调试错误时不得输出 Key、完整请求体或敏感上游响应。
