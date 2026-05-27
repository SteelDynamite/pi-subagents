/**
 * agent-dashboard.ts — Multi-agent dashboard overlay.
 */

import { type AgentSession } from "@earendil-works/pi-coding-agent";
import { type Component, decodeKittyPrintable, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentManager } from "../agent-manager.js";
import type { AgentRecord } from "../types.js";
import { getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import {
  type AgentActivity,
  buildInvocationTags,
  buildRuntimeInfoParts,
  describeActivity,
  formatDuration,
  formatSessionTokens,
  formatTurns,
  getDisplayName,
  getPromptModeLabel,
  SPINNER,
  type Theme,
} from "./agent-widget.js";
import { buildConversationContentLines } from "./conversation-transcript.js";
import { VIEWPORT_HEIGHT_PCT } from "./conversation-viewer.js";

const MIN_VIEWPORT = 5;
const CHROME_LINES = 6;

type Mode = "normal" | "steering" | "confirmStop";

type ActionResult = { ok: boolean; message: string };

export interface AgentDashboardOptions {
  tui: TUI;
  manager: AgentManager;
  agentActivity: Map<string, AgentActivity>;
  initialAgentId?: string;
  theme: Theme;
  onSteer: (record: AgentRecord, message: string) => Promise<ActionResult>;
  onStop: (record: AgentRecord) => Promise<ActionResult> | ActionResult;
  done: (result: undefined) => void;
}

export class AgentDashboard implements Component {
  private selectedId: string | undefined;
  private scrollById = new Map<string, number>();
  private autoFollowById = new Map<string, boolean>();
  private unsubscribe: (() => void) | undefined;
  private subscribedSession: AgentSession | undefined;
  private mode: Mode = "normal";
  private inputBuffer = "";
  private footerMessage: string | undefined;
  private closed = false;
  private lastFeedW = 0;
  private spinnerFrame = 0;

  constructor(private opts: AgentDashboardOptions) {
    this.selectedId = opts.initialAgentId;
    this.ensureSelection();
    this.rebindSubscription();
  }

  handleInput(data: string): void {
    if (this.mode === "steering") {
      this.handleSteeringInput(data);
      return;
    }
    if (this.mode === "confirmStop") {
      this.handleStopConfirmInput(data);
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.close();
      return;
    }

    if (matchesKey(data, "tab") || matchesKey(data, "]") || matchesKey(data, "n")) {
      this.selectRelative(1);
    } else if (matchesKey(data, "shift+tab") || matchesKey(data, "[") || matchesKey(data, "p")) {
      this.selectRelative(-1);
    } else if (matchesKey(data, "s")) {
      this.mode = "steering";
      this.inputBuffer = "";
      this.footerMessage = undefined;
    } else if (matchesKey(data, "x")) {
      this.mode = "confirmStop";
      this.footerMessage = undefined;
    } else {
      this.handleScrollInput(data);
    }
    this.opts.tui.requestRender();
  }

  render(width: number): string[] {
    if (width < 20) return [];
    this.ensureSelection();
    this.rebindSubscription();
    this.spinnerFrame++;

    const th = this.opts.theme;
    const innerW = width - 4;
    const listW = Math.max(18, Math.min(36, Math.floor(innerW * 0.36)));
    const sepW = 3;
    const feedW = Math.max(8, innerW - listW - sepW);
    this.lastFeedW = feedW;

    const records = this.orderedAgents();
    const selected = this.selectedRecord();
    const viewportHeight = this.viewportHeight();
    const lines: string[] = [];

    const row = (content: string) => th.fg("border", "│") + " " + truncateToWidth(this.pad(content, innerW), innerW) + " " + th.fg("border", "│");
    const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
    const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`);
    const hrMid = row(th.fg("dim", "─".repeat(innerW)));

    lines.push(hrTop);
    lines.push(row(th.bold("Subagents")));
    lines.push(row(this.twoPane(th.bold("Agents"), listW, sepW, this.feedTitle(selected), feedW)));
    lines.push(hrMid);

    const agentLines = this.agentListLines(records, listW, viewportHeight);
    const feedLines = this.feedLines(selected, feedW, viewportHeight);
    for (let i = 0; i < viewportHeight; i++) {
      lines.push(row(this.twoPane(agentLines[i] ?? "", listW, sepW, feedLines[i] ?? "", feedW)));
    }

    lines.push(hrMid);
    lines.push(row(this.footer(innerW)));
    lines.push(hrBot);

    return lines.map(l => truncateToWidth(l, width));
  }

  invalidate(): void { /* no cached layout */ }

  dispose(): void { this.close(false); }

  private close(callDone = true): void {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.subscribedSession = undefined;
    if (callDone) this.opts.done(undefined);
  }

  private handleSteeringInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.mode = "normal";
      this.inputBuffer = "";
      this.footerMessage = "Steer cancelled.";
      this.opts.tui.requestRender();
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      const message = this.inputBuffer.trim();
      this.mode = "normal";
      this.inputBuffer = "";
      if (message) void this.sendSteer(message);
      else this.footerMessage = "Empty steer cancelled.";
      this.opts.tui.requestRender();
      return;
    }
    if (matchesKey(data, "backspace")) {
      this.inputBuffer = this.inputBuffer.slice(0, -1);
      this.opts.tui.requestRender();
      return;
    }
    const printable = decodeKittyPrintable(data) ?? (data.length === 1 && data >= " " ? data : undefined);
    if (printable) {
      this.inputBuffer += printable;
      this.opts.tui.requestRender();
    }
  }

  private handleStopConfirmInput(data: string): void {
    this.mode = "normal";
    if (matchesKey(data, "y")) {
      void this.stopSelected();
    } else {
      this.footerMessage = "Stop cancelled.";
    }
    this.opts.tui.requestRender();
  }

  private handleScrollInput(data: string): void {
    const id = this.selectedId;
    if (!id) return;
    const totalLines = this.feedContentLines(this.selectedRecord(), this.lastFeedW).length;
    const maxScroll = Math.max(0, totalLines - this.viewportHeight());
    let scroll = this.scrollById.get(id) ?? maxScroll;
    let changed = true;

    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      scroll = Math.max(0, scroll - 1);
    } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
      scroll = Math.min(maxScroll, scroll + 1);
    } else if (matchesKey(data, "pageUp") || matchesKey(data, "shift+up")) {
      scroll = Math.max(0, scroll - this.viewportHeight());
    } else if (matchesKey(data, "pageDown") || matchesKey(data, "shift+down")) {
      scroll = Math.min(maxScroll, scroll + this.viewportHeight());
    } else if (matchesKey(data, "home")) {
      scroll = 0;
    } else if (matchesKey(data, "end")) {
      scroll = maxScroll;
    } else {
      changed = false;
    }

    if (changed) {
      this.scrollById.set(id, scroll);
      this.autoFollowById.set(id, scroll >= maxScroll);
    }
  }

  private selectRelative(delta: number): void {
    const records = this.orderedAgents();
    if (records.length === 0) return;
    const current = records.findIndex(r => r.id === this.selectedId);
    const next = current < 0 ? 0 : (current + delta + records.length) % records.length;
    this.selectedId = records[next]?.id;
    if (this.selectedId && !this.autoFollowById.has(this.selectedId)) this.autoFollowById.set(this.selectedId, true);
    this.rebindSubscription();
  }

  private async sendSteer(message: string): Promise<void> {
    const record = this.selectedRecord();
    if (!record) {
      this.footerMessage = "Agent not found.";
      this.opts.tui.requestRender();
      return;
    }
    this.footerMessage = "Sending steer…";
    this.opts.tui.requestRender();
    try {
      const res = await this.opts.onSteer(record, message);
      this.footerMessage = res.message;
    } catch (err) {
      this.footerMessage = `Failed to steer: ${err instanceof Error ? err.message : String(err)}`;
    }
    this.opts.tui.requestRender();
  }

  private async stopSelected(): Promise<void> {
    const record = this.selectedRecord();
    if (!record) {
      this.footerMessage = "Agent not found.";
      this.opts.tui.requestRender();
      return;
    }
    this.footerMessage = "Stopping agent…";
    this.opts.tui.requestRender();
    try {
      const res = await this.opts.onStop(record);
      this.footerMessage = res.message;
    } catch (err) {
      this.footerMessage = `Failed to stop: ${err instanceof Error ? err.message : String(err)}`;
    }
    this.opts.tui.requestRender();
  }

  private viewportHeight(): number {
    const maxRows = Math.floor((this.opts.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
    return Math.max(MIN_VIEWPORT, maxRows - CHROME_LINES);
  }

  private orderedAgents(): AgentRecord[] {
    const all = this.opts.manager.listAgents();
    const running = all.filter(a => a.status === "running");
    const queued = all.filter(a => a.status === "queued");
    const finished = all.filter(a => a.status !== "running" && a.status !== "queued");
    return [...running, ...queued, ...finished];
  }

  private ensureSelection(): void {
    const records = this.orderedAgents();
    if (records.length === 0) {
      this.selectedId = undefined;
      return;
    }
    if (!this.selectedId || !records.some(r => r.id === this.selectedId)) {
      this.selectedId = records[0]?.id;
    }
  }

  private selectedRecord(): AgentRecord | undefined {
    return this.selectedId ? this.opts.manager.getRecord(this.selectedId) : undefined;
  }

  private rebindSubscription(): void {
    const session = this.selectedRecord()?.session;
    if (session === this.subscribedSession) return;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.subscribedSession = session;
    if (session) {
      this.unsubscribe = session.subscribe(() => {
        if (!this.closed) this.opts.tui.requestRender();
      });
    }
  }

  private agentListLines(records: AgentRecord[], width: number, height: number): string[] {
    if (records.length === 0) return [this.opts.theme.fg("dim", "No agents.")];
    const selectedIndex = Math.max(0, records.findIndex(r => r.id === this.selectedId));
    const start = Math.max(0, Math.min(selectedIndex - Math.floor(height / 2), records.length - height));
    return records.slice(start, start + height).map(r => this.agentLine(r, width));
  }

  private agentLine(record: AgentRecord, width: number): string {
    const th = this.opts.theme;
    const selected = record.id === this.selectedId;
    const pointer = selected ? th.fg("accent", ">") : " ";
    const icon = this.statusIcon(record);
    const name = getDisplayName(record.type);
    const activity = this.opts.agentActivity.get(record.id);
    const suffix = record.status === "running" && activity
      ? describeActivity(activity.activeTools, activity.responseText)
      : record.status;
    return truncateToWidth(`${pointer} ${icon} ${name} ${th.fg("dim", "—")} ${th.fg("muted", record.description)} ${th.fg("dim", suffix)}`, width);
  }

  private statusIcon(record: AgentRecord): string {
    const th = this.opts.theme;
    if (record.status === "running") return th.fg("accent", SPINNER[this.spinnerFrame % SPINNER.length]);
    if (record.status === "queued") return th.fg("muted", "◦");
    if (record.status === "completed") return th.fg("success", "✓");
    if (record.status === "steered") return th.fg("warning", "✓");
    if (record.status === "stopped") return th.fg("dim", "■");
    return th.fg("error", "✗");
  }

  private feedTitle(record: AgentRecord | undefined): string {
    if (!record) return this.opts.theme.fg("dim", "Feed");
    const th = this.opts.theme;
    const mode = getPromptModeLabel(record.type);
    const modeTag = mode ? ` ${th.fg("dim", `(${mode})`)}` : "";
    return `${th.bold(getDisplayName(record.type))}${modeTag} ${th.fg("dim", "·")} ${th.fg("muted", record.description)}`;
  }

  private feedLines(record: AgentRecord | undefined, width: number, height: number): string[] {
    const content = this.feedContentLines(record, width);
    const id = record?.id;
    const maxScroll = Math.max(0, content.length - height);
    let scroll = id ? (this.scrollById.get(id) ?? maxScroll) : 0;
    const auto = id ? (this.autoFollowById.get(id) ?? true) : true;
    if (auto) scroll = maxScroll;
    scroll = Math.min(scroll, maxScroll);
    if (id) this.scrollById.set(id, scroll);
    return content.slice(scroll, scroll + height);
  }

  private feedContentLines(record: AgentRecord | undefined, width: number): string[] {
    const th = this.opts.theme;
    if (!record) return [th.fg("dim", "Agent no longer available.")];

    const activity = this.opts.agentActivity.get(record.id);
    const lines: string[] = [];
    const meta = this.metaLine(record, activity);
    if (meta) lines.push(meta);
    const invocation = this.invocationLine(record);
    if (invocation) lines.push(invocation);

    if (record.status === "queued" && !record.session) {
      lines.push(th.fg("dim", "Queued — session has not started."));
      if (record.pendingSteers?.length) lines.push(th.fg("dim", `${record.pendingSteers.length} pending steer${record.pendingSteers.length === 1 ? "" : "s"}.`));
      return lines.map(l => truncateToWidth(l, width));
    }

    if (!record.session) {
      lines.push(th.fg("dim", `No session available for ${record.status} agent.`));
      if (record.result) lines.push(...record.result.split("\n").map(l => th.fg("dim", l)));
      return lines.map(l => truncateToWidth(l, width));
    }

    lines.push(...buildConversationContentLines({ session: record.session, record, activity, theme: th, width }));
    return lines.map(l => truncateToWidth(l, width));
  }

  private metaLine(record: AgentRecord, activity: AgentActivity | undefined): string {
    const th = this.opts.theme;
    const parts: string[] = [record.status, formatDuration(record.startedAt, record.completedAt)];
    const runtime = buildRuntimeInfoParts(record);
    if (runtime.length) parts.push(...runtime);
    if (activity) parts.push(formatTurns(activity.turnCount, activity.maxTurns));
    const toolUses = activity?.toolUses ?? record.toolUses;
    if (toolUses > 0) parts.push(`${toolUses} tool${toolUses === 1 ? "" : "s"}`);
    const tokens = getLifetimeTotal(activity?.lifetimeUsage ?? record.lifetimeUsage);
    if (tokens > 0) parts.push(formatSessionTokens(tokens, getSessionContextPercent(record.session), th, record.compactionCount));
    if (record.error) parts.push(th.fg("error", record.error));
    return th.fg("dim", parts.join(" · "));
  }

  private invocationLine(record: AgentRecord): string | undefined {
    const { modelName, tags } = buildInvocationTags(record.invocation);
    const parts = modelName ? [modelName, ...tags] : tags;
    return parts.length ? this.opts.theme.fg("dim", `↳ ${parts.join(" · ")}`) : undefined;
  }

  private footer(width: number): string {
    const th = this.opts.theme;
    let text: string;
    if (this.mode === "steering") text = `Steer: ${this.inputBuffer}`;
    else if (this.mode === "confirmStop") text = "Stop selected agent? y confirm · any other key cancel";
    else if (this.footerMessage) text = this.footerMessage;
    else text = "Tab/]/n next · Shift+Tab/[/p prev · ↑↓ scroll · s steer · x stop · Esc close";
    return truncateToWidth(th.fg(this.footerMessage ? "muted" : "dim", text), width);
  }

  private twoPane(left: string, leftW: number, sepW: number, right: string, rightW: number): string {
    void sepW;
    const sep = this.opts.theme.fg("border", " │ ");
    return `${this.pad(truncateToWidth(left, leftW), leftW)}${sep}${this.pad(truncateToWidth(right, rightW), rightW)}`;
  }

  private pad(s: string, width: number): string {
    return s + " ".repeat(Math.max(0, width - visibleWidth(s)));
  }
}
