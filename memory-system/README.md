# Novel Memory System 0.0.1

本项目是本地优先的长篇小说叙事记忆内核和评测台，也是面向 DeepSeek Harness（DSH）的小说写作协作插件基础。它让 DSH 内的 AI 通过职责明确的写作子代理协作完成小说任务，并把原文、候选记忆、正式记忆、冲突、用户裁决和上下文检索分开保存，确保 AI 生成的派生数据不会未经确认覆盖正式事实。

项目当前只适配 DSH。Fastify API 和 Web 评测台主要用于本地调试、回归测试和数据检查，最终用户工作流由 DSH 插件承载。系统不追求单个模型通吃规划、检索、写作、审校和风格编辑，而是按模型优势拆分任务，并用受预算约束的 ContextPack 缓解子代理上下文压力。完整定位、子代理分工、DSH 插件边界和命名决定见 `PROJECT_OVERVIEW.md`。

## 0.0.1 范围

已完成一个可运行的最小闭环：

- 创建项目并隔离项目数据
- 提交设定、正文或大纲
- 校验候选记忆的 UTF-16 证据区间
- 无模型时使用规则抽取降级；配置 OpenAI-compatible 服务后可使用抽取、冲突复核和 Embedding
- 检测同一认知域内的事实、状态、规则、空间和计划冲突
- 冲突自动阻断 Canon 写入，等待显式裁决
- 支持共存、重分类、retcon 既有记忆和拒绝整份提交
- 持久化异步 review 队列、重试、任务事件和 SSE
- 结构化检索、SQLite FTS、可选 Embedding 排序、认知域分栏和 token 预算裁剪
- 保存 retrieval trace、模型请求指标和项目审计结果
- 提供一个用于导入、裁决、浏览记忆和调试上下文的 Web 评测台

以下内容不属于 0.0.1：写作 Agent 编排、复杂文档格式导入导出、多用户权限、多进程 worker、生产级模型监控和完整的迟发审计冻结界面。

## 环境

- Node.js 22 或更新版本
- npm
- Windows、macOS 或 Linux 均可运行；Windows 路径示例使用 PowerShell

## 安装与启动

```powershell
Set-Location -LiteralPath 'D:\book\memory-system'
npm install
npm run check
npm run dev
```

开发服务：

- Web：`http://127.0.0.1:5188`
- API：`http://127.0.0.1:8790`
- 健康检查：`GET http://127.0.0.1:8790/api/health`

预期响应：

```json
{"ok":true,"version":"0.0.1"}
```

生产构建：

```powershell
Set-Location -LiteralPath 'D:\book\memory-system'
npm run build
npm start
```

`npm start` 会由 API 服务同时托管 `dist-web`。如果只需要 API，可运行 `npm run dev:api`。

## 数据与模型配置

默认数据库：

```text
D:\book\memory-system\memory-system-data\memory.sqlite
```

运行数据、构建产物和依赖已加入 `.gitignore`。需要迁移或备份时，应在停止服务后复制 SQLite 主文件以及同目录的 WAL/SHM 文件。

环境变量模板见 `.env.example`：

```text
MEMORY_PORT=8790
MEMORY_HOST=127.0.0.1
MEMORY_DATA_DIR=D:\book\memory-system-data
MEMORY_OPENAI_API_KEY=
```

当前程序不会自动读取 `.env` 文件，请通过 PowerShell、系统环境或进程管理器注入变量。模型配置也可以通过 API 保存：

```text
GET /api/models/:role
PUT /api/models/:role
```

角色为 `extractor`、`verifier`、`embedding`。Base URL 必须是 HTTP(S) 地址，模型名不能为空，温度范围为 0 到 2，最大输出 token 必须为正整数。模型未启用时，抽取会使用本地规则降级，Embedding 检索自动退化为结构化 + FTS 路径。

## 核心工作流

```text
POST /api/projects
  -> POST /api/projects/:projectId/submissions
  -> POST /api/projects/:projectId/submissions/:submissionId/review
  -> 无冲突：committed
  -> 有冲突：blocked
  -> POST /api/projects/:projectId/conflicts/:conflictId/resolve
  -> committed 或 rejected
  -> POST /api/projects/:projectId/context
```

常用接口：

```text
GET  /api/projects
GET  /api/projects/:projectId/submissions
GET  /api/projects/:projectId/submissions/:submissionId
GET  /api/projects/:projectId/memories
GET  /api/projects/:projectId/conflicts
GET  /api/projects/:projectId/audit

POST /api/projects/:projectId/submissions/:submissionId/review?async=true
GET  /api/projects/:projectId/jobs/:jobId
GET  /api/jobs/:jobId/events

POST /api/projects/:projectId/context
GET  /api/projects/:projectId/traces/:traceId
POST /api/projects/:projectId/embeddings/index
```

提交候选的 `spanStart`、`spanEnd` 使用 JavaScript UTF-16 左闭右开区间，`spanText` 必须等于原文切片。系统不会把没有证据的候选写入正式记忆。

## 验收命令

```powershell
Set-Location -LiteralPath 'D:\book\memory-system'
npm run typecheck
npm test
npm run build
npm run benchmark -- 1500000
```

一次完整检查也可以直接运行：

```powershell
npm run check
```

基准命令使用本地内存数据库和规则候选，不调用云模型，主要验证大文本下的结构化检索和 FTS 路径。

## 目录

- `src/database.ts`：SQLite WAL schema
- `src/memory-service.ts`：提交、审查、Canon、冲突裁决和审计
- `src/conflicts.ts`：冲突提案生成
- `src/retrieval.ts`：上下文检索和 trace
- `src/models.ts`：模型适配、缓存、重试和指标
- `src/job-worker.ts`：持久化 review worker
- `src/main.ts`：Fastify API
- `web/src/App.tsx`：评测台
- `src/*.test.ts`：单元和 HTTP 集成测试
- `HANDOFF.md`：当前接手记录
- `operations/old-project-removal/`：旧项目移除和回滚记录

## 设计边界

正式原文和用户明确裁决是权威。AI 抽取、实体、图谱、摘要、索引和状态投影都是可重建派生数据。确定冲突和无法解释的歧义必须阻止正式化；系统不自动决定哪一条剧情或设定正确。

旧 Novel Studio 不属于当前项目。旧文件的外部回滚目录和校验记录见 `HANDOFF.md`，除非明确要求回滚，不要恢复旧代码。
