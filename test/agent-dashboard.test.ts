import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import { AgentDashboard } from "../src/ui/agent-dashboard.js";

function mockTui(rows = 30, columns = 100) {
  return { terminal: { rows, columns }, requestRender: vi.fn() } as any;
}

function theme() {
  return { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
}

function session(messages: any[] = []) {
  const unsub = vi.fn();
  return {
    messages,
    subscribe: vi.fn(() => unsub),
    steer: vi.fn(),
    __unsub: unsub,
  } as any;
}

function record(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a1",
    type: "general-purpose",
    description: "agent one",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...overrides,
  } as AgentRecord;
}

function manager(records: AgentRecord[]) {
  return {
    listAgents: vi.fn(() => records),
    getRecord: vi.fn((id: string) => records.find(r => r.id === id)),
    abort: vi.fn((id: string) => !!records.find(r => r.id === id)),
  } as any;
}

function makeDashboard(records: AgentRecord[], initialAgentId?: string, overrides: Partial<ConstructorParameters<typeof AgentDashboard>[0]> = {}) {
  const tui = mockTui();
  const opts = {
    tui,
    manager: manager(records),
    agentActivity: new Map(),
    initialAgentId,
    theme: theme(),
    onSteer: vi.fn(async () => ({ ok: true, message: "Steering message sent." })),
    onStop: vi.fn(async () => ({ ok: true, message: "Agent stopped." })),
    done: vi.fn(),
    ...overrides,
  };
  return { dashboard: new AgentDashboard(opts), opts };
}

function assertFits(lines: string[], width: number) {
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
}

describe("AgentDashboard", () => {
  it("renders with no agents", () => {
    const { dashboard } = makeDashboard([]);
    const lines = dashboard.render(80);
    expect(lines.join("\n")).toContain("No agents");
    assertFits(lines, 80);
  });

  it("renders queued agent without session", () => {
    const queued = record({ id: "q1", status: "queued", description: "queued agent", session: undefined });
    const { dashboard } = makeDashboard([queued], "q1");
    const output = dashboard.render(100).join("\n");
    expect(output).toContain("Queued");
    expect(output).toContain("session has not started");
  });

  it("switches selected agent and unsubscribes old session", () => {
    const s1 = session([{ role: "user", content: "one" }]);
    const s2 = session([{ role: "user", content: "two" }]);
    const a1 = record({ id: "a1", description: "first", session: s1 });
    const a2 = record({ id: "a2", description: "second", session: s2 });
    const { dashboard } = makeDashboard([a1, a2], "a1");

    expect(s1.subscribe).toHaveBeenCalledTimes(1);
    dashboard.handleInput("\t");

    expect(s1.__unsub).toHaveBeenCalledTimes(1);
    expect(s2.subscribe).toHaveBeenCalledTimes(1);
    expect(dashboard.render(100).join("\n")).toContain("second");
  });

  it("s opens steer prompt and enter calls onSteer", async () => {
    const a1 = record({ session: session() });
    const onSteer = vi.fn(async () => ({ ok: true, message: "sent" }));
    const { dashboard } = makeDashboard([a1], "a1", { onSteer });

    dashboard.handleInput("s");
    dashboard.handleInput("h");
    dashboard.handleInput("i");
    dashboard.handleInput("\r");
    await vi.waitFor(() => expect(onSteer).toHaveBeenCalledTimes(1));

    expect(onSteer).toHaveBeenCalledWith(a1, "hi");
  });

  it("x requires y confirmation before stopping", async () => {
    const a1 = record({ session: session() });
    const onStop = vi.fn(async () => ({ ok: true, message: "stopped" }));
    const { dashboard } = makeDashboard([a1], "a1", { onStop });

    dashboard.handleInput("x");
    dashboard.handleInput("n");
    expect(onStop).not.toHaveBeenCalled();

    dashboard.handleInput("x");
    dashboard.handleInput("y");
    await vi.waitFor(() => expect(onStop).toHaveBeenCalledTimes(1));
    expect(onStop).toHaveBeenCalledWith(a1);
  });

  it("clamps all rendered lines to width", () => {
    const long = "L".repeat(500);
    const a1 = record({ description: long, session: session([{ role: "assistant", content: [{ type: "text", text: long }] }]) });
    const { dashboard } = makeDashboard([a1], "a1");
    assertFits(dashboard.render(60), 60);
  });
});
