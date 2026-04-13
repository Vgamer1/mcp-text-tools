import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createTwoFilesPatch } from "diff";
import { estimateTokenCount, splitByTokens } from "tokenx";
import { z } from "zod";

// ─────────────────────────────────────────────
// Tool registration
// ─────────────────────────────────────────────

function createServer(): McpServer {
  const server = new McpServer({ name: "mcp-text-tools", version: "1.0.0" });

  server.tool(
    "diff_text",
    "Compare two strings and return a unified diff patch with added/removed line counts.",
    {
      a:       z.string().describe("Original text"),
      b:       z.string().describe("New text"),
      label_a: z.string().optional().describe("Label for original (default: 'a')"),
      label_b: z.string().optional().describe("Label for new (default: 'b')"),
    },
    async ({ a, b, label_a, label_b }) => {
      const pa = a.endsWith("\n") ? a : a + "\n";
      const pb = b.endsWith("\n") ? b : b + "\n";
      const patch = createTwoFilesPatch(label_a ?? "a", label_b ?? "b", pa, pb);
      const lines = patch.split("\n");
      const added   = lines.filter(l => l.startsWith("+") && !l.startsWith("+++")).length;
      const removed = lines.filter(l => l.startsWith("-") && !l.startsWith("---")).length;
      return { content: [{ type: "text", text: JSON.stringify({ patch, added, removed }) }] };
    }
  );

  server.tool(
    "chunk_text",
    "Split text into token-sized chunks with optional overlap. Returns chunks with per-chunk token counts.",
    {
      text:             z.string().describe("Text to split"),
      tokens_per_chunk: z.number().optional().describe("Max tokens per chunk (default: 500)"),
      overlap:          z.number().optional().describe("Token overlap between chunks (default: 0)"),
    },
    async ({ text, tokens_per_chunk, overlap }) => {
      const size = tokens_per_chunk ?? 500;
      const ovlp = overlap ?? 0;
      const chunks = splitByTokens(text, size, { overlap: ovlp });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            chunk_count: chunks.length,
            tokens_per_chunk: size,
            overlap: ovlp,
            chunks: chunks.map((t, i) => ({
              index: i,
              token_count: estimateTokenCount(t),
              text: t,
            })),
          }),
        }],
      };
    }
  );

  return server;
}

// ─────────────────────────────────────────────
// Cloudflare Worker fetch handler
// ─────────────────────────────────────────────

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", version: "1.0.0" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // OAuth discovery — required by Claude.ai even for authless servers
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return new Response(JSON.stringify({
        resource: url.origin,
        authorization_servers: [],
      }), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return new Response(null, { status: 404 });
    }

    if (url.pathname === "/register" && request.method === "POST") {
      return new Response(null, { status: 404 });
    }

    // MCP endpoint — handle both / and /mcp (Claude hits both)
    if (url.pathname === "/mcp" || url.pathname === "/") {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id",
          },
        });
      }

      const server = createServer();
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless mode
      });

      await server.connect(transport);
      return transport.handleRequest(request);
    }

    return new Response("Not found", { status: 404 });
  },
};