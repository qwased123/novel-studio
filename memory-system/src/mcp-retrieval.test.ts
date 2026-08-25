import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { openDatabase } from "./database.js";
import { createRetrievalMcpServer } from "./mcp-retrieval.js";
import { MemoryService, type MemoryModelProvider } from "./memory-service.js";

const models: MemoryModelProvider = {
  extract: async () => [],
  verifyConflict: async ({ explanation }) => ({ confirmed: true, explanation }),
};

describe("retrieval MCP adapter", () => {
  it("publishes only retrieve_context and returns a structured ContextPack", async () => {
    const db = openDatabase(":memory:");
    const memory = new MemoryService(db, models);
    const project = memory.createProject("MCP 测试");
    const content = "林舟位于北城。";
    const submission = memory.createSubmission(project.id, {
      title: "设定",
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

    const server = createRetrievalMcpServer(db);
    const client = new Client({ name: "retrieval-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(["retrieve_context"]);

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
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        tokenBudget: 100,
        worldState: [expect.objectContaining({ text: "林舟 location 北城", quote: "林舟位于北城" })],
      });
      expect((result.structuredContent as { traceId?: string }).traceId).toEqual(expect.any(String));
      expect((db.prepare("SELECT count(*) AS count FROM retrieval_traces").get() as { count: number }).count).toBe(1);
    } finally {
      await client.close();
      await server.close();
      db.close();
    }
  });

  it("returns an MCP tool error for an unknown project", async () => {
    const db = openDatabase(":memory:");
    const server = createRetrievalMcpServer(db);
    const client = new Client({ name: "retrieval-error-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "retrieve_context",
        arguments: {
          projectId: "missing",
          intent: "evidence",
          instruction: "查找证据",
          tokenBudget: 100,
        },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        expect.objectContaining({ type: "text", text: expect.stringContaining("项目不存在") }),
      ]);
    } finally {
      await client.close();
      await server.close();
      db.close();
    }
  });
});
