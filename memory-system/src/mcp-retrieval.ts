import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
import { openDatabase, type MemoryDatabase } from "./database.js";
import { RetrievalService } from "./retrieval.js";
import type { ContextRequest } from "./types.js";
import { APP_VERSION } from "./version.js";

const intentSchema = z.enum([
  "current_state",
  "scene_generation",
  "timeline",
  "causal",
  "foreshadowing",
  "evidence",
  "summary",
]);

const inputSchema = {
  projectId: z.string().trim().min(1).describe("Novel Memory project id."),
  intent: intentSchema.describe("Retrieval intent controlling ranking and context buckets."),
  instruction: z.string().trim().min(1).describe("The concrete novel-writing or continuity question."),
  tokenBudget: z.number().int().positive().max(200_000).describe("Maximum estimated tokens returned in the ContextPack."),
  chapter: z.string().trim().min(1).nullable().optional(),
  scene: z.string().trim().min(1).nullable().optional(),
  pov: z.string().trim().min(1).nullable().optional(),
  storyTime: z.string().trim().min(1).nullable().optional(),
  location: z.string().trim().min(1).nullable().optional(),
  recentText: z.string().min(1).optional(),
  mentionedEntities: z.array(z.string().trim().min(1)).max(200).optional(),
};

type RetrievalToolInput = {
  projectId: string;
  intent: ContextRequest["intent"];
  instruction: string;
  tokenBudget: number;
  chapter?: string | null;
  scene?: string | null;
  pov?: string | null;
  storyTime?: string | null;
  location?: string | null;
  recentText?: string;
  mentionedEntities?: string[];
};

export async function retrieveContextForMcp(db: MemoryDatabase, input: RetrievalToolInput) {
  const { projectId, ...request } = input;
  return new RetrievalService(db).compileContext(projectId, request);
}

export function createRetrievalMcpServer(db: MemoryDatabase) {
  const server = new McpServer({ name: "novel-memory-retrieval", version: APP_VERSION });

  server.registerTool("retrieve_context", {
    title: "Retrieve Novel Context",
    description: "Retrieve an evidence-backed, token-budgeted ContextPack for a novel task. Returns hard constraints, world state, POV knowledge, revealed facts, relevant history, open commitments, plan drift, disputes, omissions, and evidence references. This tool is read-only and never submits text or changes Canon.",
    inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args) => {
    try {
      const pack = await retrieveContextForMcp(db, args);
      return {
        content: [{ type: "text", text: JSON.stringify(pack) }],
        structuredContent: { ...pack },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Novel context retrieval failed: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

export async function startRetrievalMcpServer() {
  const db = openDatabase();
  const server = createRetrievalMcpServer(db);
  const closeDatabase = () => {
    if (db.open) db.close();
  };
  process.once("beforeExit", closeDatabase);
  process.once("SIGINT", () => {
    void server.close().finally(() => {
      closeDatabase();
      process.exitCode = 130;
    });
  });
  await server.connect(new StdioServerTransport());
  return { server, db };
}

const invokedFile = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  void startRetrievalMcpServer().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
