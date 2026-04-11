# Contributing to mcp-text-tools

Thanks for your interest. Contributions are welcome — new tools, bug fixes, and documentation improvements all matter.

## What we're looking for

**Good contributions:**
- New text processing tools that are deterministic and have no AI dependency
- Bug fixes with a clear description of the problem
- Better input validation or error messages
- Documentation improvements

**Not a good fit:**
- Tools that require an external API or AI model call
- Tools that duplicate what Unix builtins or common npm packages already do cleanly
- Anything that adds significant bundle size without clear payoff

## Adding a new tool

Tools live in `src/index.ts` inside the `init()` method of `TextToolsMCP`. A tool should do one thing, accept and return JSON, have no side effects, and be under ~20 lines of logic.

```typescript
this.paidTool(
  "tool_name",
  "One sentence description of what it does.",
  {
    input: z.string().describe("What this parameter is"),
  },
  async ({ input }) => {
    const result = doSomething(input);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
  generatePaidToolConfig("describe what this does")
);
```

## Development setup

```bash
git clone https://github.com/YOUR-USERNAME/mcp-text-tools
cd mcp-text-tools
npm install
cp .dev.vars.example .dev.vars   # add your Stripe test key
npm run dev
```

The server runs at `http://localhost:8787/mcp`.

## Submitting a PR

1. Fork the repo and create a branch: `git checkout -b add-my-tool`
2. Make your changes
3. Test locally with `npm run dev`
4. Open a PR with a clear title and description of what the tool does and why it belongs here
