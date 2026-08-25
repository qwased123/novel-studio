# DSH 检索验证

本目录当前只验证一件事：DeepSeek Harness 能发现并调用 Novel Memory System 的只读 `retrieve_context` MCP 工具。

本轮不向 DSH 暴露来源提交、审查、冲突裁决或 Canon 写入能力。

## 工具边界

DSH 中的公开工具名为：

```text
mcp__novel-memory__retrieve_context
```

原始 MCP 工具名为 `retrieve_context`。它接收项目、检索意图、具体问题、token 预算和可选场景字段，返回完整结构化 `ContextPack`。调用会保存 retrieval trace，但不会提交文本、创建记忆或修改 Canon。

## 准备

```powershell
Set-Location -LiteralPath 'D:\book\memory-system'
npm install
npm run build
npm run seed:retrieval-demo
```

seed 命令会打印演示项目的 `projectId`，并可重复执行。它使用独立的本地命令准备确定性记忆数据，不是 DSH 可调用的工具。

## 检查 DSH 配置组合

```powershell
Set-Location -LiteralPath 'D:\deepseek-harness'
$env:NOVEL_MEMORY_ROOT = 'D:\book\memory-system'
pnpm dsh --profile web --patch 'D:\book\memory-system\dsh\retrieval-only.cordis.yml' --dump-config
```

输出中应包含：

```text
id: novel-memory-retrieval
name: '@deepseek-ai/dsh-mcp-client'
serverName: novel-memory
```

## 启动 DSH

对已安装的 DSH：

```powershell
Set-Location -LiteralPath 'D:\book'
$env:NOVEL_MEMORY_ROOT = 'D:\book\memory-system'
dsh web --patch 'D:\book\memory-system\dsh\retrieval-only.cordis.yml'
```

从 `D:\deepseek-harness` 源码运行：

```powershell
Set-Location -LiteralPath 'D:\deepseek-harness'
$env:NOVEL_MEMORY_ROOT = 'D:\book\memory-system'
pnpm dsh web --patch 'D:\book\memory-system\dsh\retrieval-only.cordis.yml'
```

如果另行设置数据目录，同时设置：

```powershell
$env:NOVEL_MEMORY_DATA_DIR = 'D:\path\to\memory-data'
```

## 验证提示词

将 seed 输出中的项目 id 替换到下面的提示词：

```text
调用小说记忆检索工具查询项目 <projectId>。intent 使用 current_state，instruction 使用“林舟目前在哪里，持有什么？”，mentionedEntities 传入 ["林舟"]，tokenBudget 使用 200。只报告工具返回的世界状态、证据和 traceId，不执行任何写入操作。
```

预期结果至少包含：

```text
林舟 location 北城
林舟 holds_item 青铜钥匙
```

并包含对应原文证据和非空 `traceId`。

## 环境变量

| 变量 | 默认值 | 用途 |
|---|---|---|
| `NOVEL_MEMORY_ROOT` | `D:/book/memory-system` | 构建后 MCP 入口所在目录 |
| `NOVEL_MEMORY_DATA_DIR` | `<root>/memory-system-data` | SQLite 数据目录 |

Cordis overlay 使用 DSH 当前 Node 可执行文件启动 `dist/src/mcp-retrieval.js`。因此修改 TypeScript 后必须先运行 `npm run build`。
