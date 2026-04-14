import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createTwoFilesPatch, parsePatch } from "diff";
import { estimateTokenCount, splitByTokens } from "tokenx";
import { z } from "zod";

// ─────────────────────────────────────────────
// Constraints
// ─────────────────────────────────────────────

const MAX_TEXT_LENGTH = 1_000_000; // 1 MB
const MAX_LABEL_LENGTH = 200;
const MIN_TOKENS_PER_CHUNK = 1;
const MAX_TOKENS_PER_CHUNK = 10_000;
const MAX_OVERLAP = 5_000;

// ─────────────────────────────────────────────
// Tool definitions (separated from server
// instantiation so the logic is reusable and
// the per-request McpServer stays lightweight)
// ─────────────────────────────────────────────

function registerTools(server: McpServer): void {
  server.tool(
    "diff_text",
    "Compare two strings and return a unified diff patch with added/removed line counts. "
    + "Useful for change detection, patch generation, or summarizing edits.",
    {
      a: z.string().max(MAX_TEXT_LENGTH).describe("Original text"),
      b: z.string().max(MAX_TEXT_LENGTH).describe("New text"),
      label_a: z
        .string()
        .max(MAX_LABEL_LENGTH)
        .optional()
        .describe("Label for original in the patch header (default: 'a')"),
      label_b: z
        .string()
        .max(MAX_LABEL_LENGTH)
        .optional()
        .describe("Label for new in the patch header (default: 'b')"),
    },
    async ({ a, b, label_a, label_b }) => {
      try {
        const patch = createTwoFilesPatch(
          label_a ?? "a",
          label_b ?? "b",
          a,
          b,
        );

        // Use the structured parser instead of string heuristics
        // so we count correctly regardless of patch edge cases.
        const parsed = parsePatch(patch);
        let added = 0;
        let removed = 0;
        for (const file of parsed) {
          for (const hunk of file.hunks) {
            for (const line of hunk.lines) {
              if (line.startsWith("+")) added++;
              if (line.startsWith("-")) removed++;
            }
          }
        }

        return {
          content: [
            { type: "text", text: JSON.stringify({ patch, added, removed }) },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: message }) }],
        };
      }
    },
  );

  server.tool(
    "chunk_text",
    "Split text into token-sized chunks with optional overlap between consecutive chunks. "
    + "Returns each chunk with its index and estimated token count. "
    + "Note: token counts are estimates (~96% accuracy vs tiktoken) — "
    + "suitable for most RAG and batching workflows but not exact.",
    {
      text: z.string().max(MAX_TEXT_LENGTH).describe("Text to split"),
      tokens_per_chunk: z
        .number()
        .int()
        .min(MIN_TOKENS_PER_CHUNK)
        .max(MAX_TOKENS_PER_CHUNK)
        .optional()
        .describe("Max tokens per chunk (default: 500)"),
      overlap: z
        .number()
        .int()
        .min(0)
        .max(MAX_OVERLAP)
        .optional()
        .describe("Token overlap between consecutive chunks (default: 0)"),
    },
    async ({ text, tokens_per_chunk, overlap }) => {
      try {
        const size = tokens_per_chunk ?? 500;
        const ovlp = overlap ?? 0;

        if (ovlp >= size) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: `overlap (${ovlp}) must be smaller than tokens_per_chunk (${size})`,
                }),
              },
            ],
          };
        }

        const chunks = splitByTokens(text, size, { overlap: ovlp });

        return {
          content: [
            {
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
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: message }) }],
        };
      }
    },
  );
}

// ─────────────────────────────────────────────
// Server factory — one fresh McpServer + transport
// per request, which is required because .connect()
// binds a server to a specific transport instance
// and cannot be reused across requests in stateless
// Cloudflare Workers.
// ─────────────────────────────────────────────

function createServer(): McpServer {
  const server = new McpServer({ name: "mcp-text-tools", version: "1.0.0" });
  registerTools(server);
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
      return new Response(
        JSON.stringify({ status: "ok", version: "1.0.0" }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // OAuth discovery — required by Claude.ai even for authless servers
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return new Response(
        JSON.stringify({
          resource: url.origin,
          authorization_servers: [],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
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
            "Access-Control-Allow-Headers":
              "Content-Type, Accept, Mcp-Session-Id",
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