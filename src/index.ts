import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import {
  PaymentState,
  experimental_PaidMcpAgent as PaidMcpAgent,
} from "@stripe/agent-toolkit/cloudflare";
import { createTwoFilesPatch } from "diff";
import { estimateTokenCount, splitByTokens } from "tokenx";
import { z } from "zod";

export type Bindings = {
  STRIPE_SECRET_KEY: string;
  MCP_OBJECT: DurableObjectNamespace;
};

type Props = {
  userEmail: string;
};

type State = PaymentState;

// ─────────────────────────────────────────────
// MCP Agent
// ─────────────────────────────────────────────

export class TextToolsMCP extends PaidMcpAgent<Bindings, State, Props> {
  server = new McpServer({ name: "mcp-text-tools", version: "1.0.0" });

  async init() {

    // ── PAID ─────────────────────────────────
    // diff_text: compare two strings, return
    // a unified diff patch with change counts.

    this.paidTool(
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
      },
      {
        paymentReason: "diff two text strings",
        checkout: {
          mode: "payment",
          line_items: [{ price: "YOUR_STRIPE_PRICE_ID", quantity: 1 }],
        },
      }
    );

    // ── PAID ─────────────────────────────────
    // chunk_text: split text into token-sized
    // chunks with optional overlap.

    this.paidTool(
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
      },
      {
        paymentReason: "split text into token-sized chunks",
        checkout: {
          mode: "payment",
          line_items: [{ price: "YOUR_STRIPE_PRICE_ID", quantity: 1 }],
        },
      }
    );

    // ── ADD MORE TOOLS BELOW ──────────────────
    // Use this.paidTool() for pay-per-call tools
  }
}

// ─────────────────────────────────────────────
// Cloudflare Worker fetch handler
// ─────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", version: "1.0.0" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // MCP endpoint
    return TextToolsMCP.serve("/mcp", {
      binding: "MCP_OBJECT",
    }).fetch(request, env);
  },
};