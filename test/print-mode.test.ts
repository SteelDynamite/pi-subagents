import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return {
    ...actual,
    runAgent: vi.fn(),
  };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, any>();
  const eventHandlers = new Map<string, any>();

  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: any) => {
        tools.set(tool.name, tool);
      }),
      registerCommand: vi.fn((name: string, command: any) => {
        commands.set(name, command);
      }),
      on: vi.fn((event: string, handler: any) => {
        handlers.set(event, handler);
      }),
      events: {
        emit: vi.fn(),
        on: vi.fn((event: string, handler: any) => {
          eventHandlers.set(event, handler);
          return vi.fn();
        }),
      },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(() => {
        throw new Error("stale extension context");
      }),
    } as any,
    tools,
    commands,
    handlers,
  };
}

function makeHeadlessCtx() {
  return {
    hasUI: false,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    cwd: "/tmp",
    model: undefined,
    modelRegistry: {
      find: vi.fn(),
      getAvailable: vi.fn(() => []),
    },
    sessionManager: {
      getSessionId: vi.fn(() => "session-1"),
      getBranch: vi.fn(() => []),
    },
    getSystemPrompt: vi.fn(() => "parent prompt"),
  } as any;
}

describe("scheduling removal", () => {
  it("does not expose schedule on the Agent tool schema", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const agentTool = tools.get("Agent");
    expect(agentTool.parameters.properties.schedule).toBeUndefined();
    expect(agentTool.description).not.toContain("schedule");
  });

  it("does not show scheduling in /agents menus", async () => {
    const { pi, commands } = makePi();
    subagentsExtension(pi);
    const topLevelOptions: string[][] = [];
    const settingsOptions: string[][] = [];
    const ctx = {
      ...makeHeadlessCtx(),
      hasUI: true,
      ui: {
        notify: vi.fn(),
        input: vi.fn(),
        confirm: vi.fn(),
        select: vi.fn(async (title: string, options: string[]) => {
          if (title === "Agents") {
            topLevelOptions.push(options);
            return topLevelOptions.length === 1 ? "Settings" : undefined;
          }
          if (title === "Settings") {
            settingsOptions.push(options);
            return undefined;
          }
          return undefined;
        }),
      },
    } as any;

    await commands.get("agents").handler([], ctx);

    expect(topLevelOptions[0].some(o => o.includes("Scheduled jobs"))).toBe(false);
    expect(settingsOptions[0].some(o => o.includes("Scheduling"))).toBe(false);
  });
});

describe("print mode background notifications", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("ignores stale-context errors from delayed completion nudges", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    vi.useFakeTimers();

    const agentTool = tools.get("Agent");
    await agentTool.execute(
      "tool-call-1",
      {
        prompt: "reply done",
        description: "tiny child",
        subagent_type: "general-purpose",
        run_in_background: true,
      },
      undefined,
      undefined,
      makeHeadlessCtx(),
    );

    await vi.advanceTimersByTimeAsync(100); // smart-join batch debounce
    await vi.advanceTimersByTimeAsync(200); // notification hold window

    expect(pi.sendMessage).toHaveBeenCalled();

    await handlers.get("session_shutdown")?.({}, makeHeadlessCtx());
  });
});
