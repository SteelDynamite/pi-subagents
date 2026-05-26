import { describe, expect, it } from "vitest";
import { AgentWidget, buildRuntimeInfoParts, formatModelLabel, formatMs, formatSessionTokens } from "../src/ui/agent-widget.js";

describe("formatSessionTokens", () => {
  const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };

  it("applies threshold colors (<70 dim, 70–85 warning, ≥85 error)", () => {
    expect(formatSessionTokens(1234, null, theme)).toBe("1.2k token");
    expect(formatSessionTokens(1234, 50, theme)).toBe("1.2k token (<dim>50%</dim>)");
    expect(formatSessionTokens(1234, 70, theme)).toBe("1.2k token (<warning>70%</warning>)");
    expect(formatSessionTokens(1234, 84, theme)).toBe("1.2k token (<warning>84%</warning>)");
    expect(formatSessionTokens(1234, 85, theme)).toBe("1.2k token (<error>85%</error>)");
    expect(formatSessionTokens(1234, 99, theme)).toBe("1.2k token (<error>99%</error>)");
  });

  it("annotates compaction count alongside percent", () => {
    // compactions only (e.g. immediately post-compaction, percent null)
    expect(formatSessionTokens(1234, null, theme, 1)).toBe("1.2k token (<dim>↻1</dim>)");
    expect(formatSessionTokens(1234, null, theme, 3)).toBe("1.2k token (<dim>↻3</dim>)");
    // percent + compactions, joined with ` · `
    expect(formatSessionTokens(1234, 45, theme, 2)).toBe("1.2k token (<dim>45%</dim> · <dim>↻2</dim>)");
    expect(formatSessionTokens(1234, 88, theme, 4)).toBe("1.2k token (<error>88%</error> · <dim>↻4</dim>)");
    // compactions=0 omitted
    expect(formatSessionTokens(1234, 45, theme, 0)).toBe("1.2k token (<dim>45%</dim>)");
  });
});

describe("formatMs", () => {
  it("uses seconds below one minute", () => {
    expect(formatMs(12_300)).toBe("12.3s");
    expect(formatMs(59_900)).toBe("59.9s");
  });

  it("uses minutes once the display would exceed 59 seconds", () => {
    expect(formatMs(59_950)).toBe("1m00s");
    expect(formatMs(60_000)).toBe("1m00s");
    expect(formatMs(61_000)).toBe("1m01s");
    expect(formatMs(125_000)).toBe("2m05s");
  });
});

describe("formatModelLabel", () => {
  it("builds compact labels from model names and ids", () => {
    expect(formatModelLabel({ name: "Claude Sonnet 4.5", id: "claude-sonnet-4-5-20250929" })).toBe("sonnet 4.5");
    expect(formatModelLabel({ id: "claude-haiku-4-5-20251001" })).toBe("claude-haiku-4-5");
  });
});

describe("buildRuntimeInfoParts", () => {
  it("uses effective session model and thinking level when available", () => {
    expect(buildRuntimeInfoParts({
      session: {
        model: { name: "Claude Sonnet 4.5", id: "claude-sonnet-4-5-20250929" },
        thinkingLevel: "high",
      } as any,
      invocation: { modelName: "haiku", thinking: "low" },
    })).toEqual(["sonnet 4.5", "high"]);
  });

  it("falls back to invocation details before the session exists", () => {
    expect(buildRuntimeInfoParts({
      session: undefined,
      invocation: { modelName: "haiku", thinking: "low" },
    })).toEqual(["haiku", "low"]);
  });
});

describe("AgentWidget", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  it("renders model and thinking level for running agents", () => {
    const record = {
      id: "agent-1",
      type: "general-purpose",
      description: "test subject",
      status: "running",
      toolUses: 0,
      startedAt: Date.now() - 1000,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      session: {
        model: { name: "Claude Sonnet 4.5", id: "claude-sonnet-4-5-20250929" },
        thinkingLevel: "high",
      },
    } as any;
    const activity = new Map([[record.id, {
      activeTools: new Map(),
      toolUses: 2,
      responseText: "",
      turnCount: 3,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    }]]);
    const widget = new AgentWidget({ listAgents: () => [record] } as any, activity as any);

    const lines = (widget as any).renderWidget({ terminal: { columns: 200 } }, theme).join("\n");

    expect(lines).toContain("sonnet 4.5");
    expect(lines).toContain("high");
    expect(lines).not.toContain("thinking: high");
  });
});
