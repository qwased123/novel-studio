import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./database.js";
import { MemoryService, type MemoryModelProvider } from "./memory-service.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = process.env.NOVEL_MEMORY_MCP_ENTRY ?? resolve(root, "dist/src/mcp-retrieval.js");
const tempRoot = mkdtempSync(resolve(tmpdir(), "novel-memory-mcp-"));
const dataDir = resolve(tempRoot, "data");
const databasePath = resolve(dataDir, "memory.sqlite");
const models: MemoryModelProvider = {
  extract: async () => [],
  verifyConflict: async ({ explanation }) => ({ confirmed: true, explanation }),
};

const db = openDatabase(databasePath);
const memory = new MemoryService(db, models);
const project = memory.createProject("stdio 检索验证");
const content = "林舟位于北城。";
const submission = memory.createSubmission(project.id, {
  title: "验证设定",
  kind: "setting",
  content,
  candidates: [{
    kind: "location_topology",
    scope: "world_truth",
    subject: "林舟",
    predicate: "location",
    object: "北城",
    spanStart: 0,
    spanEnd: 6,
    spanText: content.slice(0, 6),
  }],
});
await memory.reviewSubmission(project.id, submission.id);
db.close();

const client = new Client({ name: "novel-memory-stdio-check", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  cwd: root,
  env: { ...process.env, MEMORY_DATA_DIR: dataDir },
  stderr: "pipe",
});
if (transport.stderr) transport.stderr.on("data", (chunk) => process.stderr.write(chunk));

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const toolNames = listed.tools.map((tool) => tool.name);
  if (toolNames.length !== 1 || toolNames[0] !== "retrieve_context") {
    throw new Error(`unexpected MCP tool list: ${JSON.stringify(toolNames)}`);
  }
  const result = await client.callTool({
    name: "retrieve_context",
    arguments: {
      projectId: project.id,
      intent: "current_state",
      instruction: "林舟在哪里？",
      mentionedEntities: ["林舟"],
      tokenBudget: 100,
    },
  });
  if (result.isError) throw new Error(`retrieve_context returned an error: ${JSON.stringify(result.content)}`);
  const structured = result.structuredContent as { worldState?: Array<{ text?: string }>; traceId?: string } | undefined;
  if (structured?.worldState?.[0]?.text !== "林舟 location 北城" || typeof structured.traceId !== "string") {
    throw new Error(`unexpected ContextPack: ${JSON.stringify(structured)}`);
  }
  console.log(JSON.stringify({ entry, toolNames, projectId: project.id, worldState: structured.worldState, traceId: structured.traceId }, null, 2));
} finally {
  await client.close().catch(() => undefined);
  rmSync(tempRoot, { recursive: true, force: true });
}
