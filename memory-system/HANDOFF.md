# Novel Memory System 0.0.1 交接记录

更新时间：2026-08-22（Asia/Shanghai）

## 版本状态

当前实现版本为 `0.0.1`。这是本地优先的叙事记忆内核和评测台首个可交付纵向切片，不恢复旧 Novel Studio。

## 项目定位（必须保留）

本项目最终形态是面向 DeepSeek Harness（DSH）的小说写作协作插件，不是独立写作 SaaS，也不是单模型通吃所有工作的应用。

DSH 主代理负责拆解任务和编排，规划、检索研究、正文写作、连续性审校、风格编辑和记忆审查由职责明确的子代理分工完成。不同子代理可以使用不同模型，以利用模型在文笔、推理、规划和审校方面的差异；每个子代理只获得完成当前任务所需的最小上下文，避免浪费有限上下文窗口。

Memory System 是事实和记忆闸门：子代理只能生成计划、报告、正文候选或候选记忆，不能直接覆盖 Canon。原文证据和用户明确裁决是权威；冲突必须阻断正式化，等待用户选择共存、重分类、retcon 或拒绝提交。

当前只考虑 DSH 适配，其他 Harness 和通用 Agent 平台暂不考虑。Fastify API 和 Web 评测台是本地调试与回归入口，最终写作工作流应由 DSH 插件承载。完整说明见 `PROJECT_OVERVIEW.md`。

## 本次完成

- 统一 `package.json`、`package-lock.json` 和 API 健康检查版本为 `0.0.1`。
- 新增根目录 `README.md`、`npm run check` 和完整环境变量模板。
- 新增提交列表和提交详情 API，评测台显示提交状态、更新时间和失败原因。
- 修复评测台记忆证据字段错误，使用后端实际返回的 `spanText`。
- 拒绝提交时一次性关闭该提交的全部 open conflicts，并为每一条冲突写入 resolution 审计记录。
- 收紧模型 Base URL、temperature、maxOutputTokens 校验。
- 收紧上下文请求、分页参数和任务事件入口校验。
- 增加多冲突拒绝、模型配置、API 版本、提交列表、非法上下文和缺失任务测试。
- 增加窄屏基础布局，保留桌面评测台的密度和可扫描性。

## 核心原则

正式原文和用户明确裁决是权威。AI 抽取、实体、图谱、摘要、索引和状态投影都是可重建派生数据。确定冲突和无法解释的歧义阻止正式化；系统不自动选择哪条设定正确。

## 验证结果

在 `D:\book\memory-system` 执行：

```text
npm run typecheck 通过
npm test           5 个测试文件、17 个测试全部通过
npm run build      通过
npm run check      通过
```

150 万字本地 benchmark 最近一次结果：

```text
generatedChars: 1,500,609
memories:       1,221
retrieval p50:  29.23 ms
retrieval p95:  39.26 ms
```

API 启动后：

```json
{"ok":true,"version":"0.0.1"}
```

Embedding benchmark 默认关闭云模型，只验证结构化 + FTS 路径。

## 启动

```powershell
Set-Location -LiteralPath 'D:\book\memory-system'
npm install
npm run check
npm run dev
```

- Web：`http://127.0.0.1:5188`
- API：`http://127.0.0.1:8790`
- 健康检查：`GET /api/health`

生产启动：

```powershell
npm run build
npm start
```

默认数据：`D:\book\memory-system\memory-system-data\memory.sqlite`。

## 主要文件

- `src/main.ts`：API、静态托管、SSE
- `src/memory-service.ts`：提交、审查、Canon、冲突裁决、retcon、审计
- `src/retrieval.ts`：上下文编译和检索 trace
- `src/models.ts`：OpenAI-compatible 模型、缓存、重试、指标
- `src/job-worker.ts`：持久化 review worker
- `web/src/App.tsx`：评测台
- `README.md`：使用说明和 0.0.1 范围

## 明确未完成

- 写作 Agent 编排和正文生成
- 多用户权限与认证
- 多进程 worker 的严格锁
- 生产级模型健康仪表盘、指标清理和错误脱敏
- 复杂格式导入导出
- 完整迟发审计冻结 UI

## Git 状态

当前没有创建新 commit。`main` 比 `origin/main` ahead 4 个既有提交；旧项目文件继续显示为删除，`memory-system` 仍是新增未跟踪目录。不要使用 reset/checkout 回滚，也不要恢复旧项目，除非用户明确要求。

旧项目回滚目录：

```text
D:\book-old-project-rollback-20260820T1900
```
