/**
 * conversation-transcript.ts — Shared transcript rendering helpers for agent sessions.
 */

import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { extractText } from "../context.js";
import type { AgentRecord } from "../types.js";
import type { AgentActivity, Theme } from "./agent-widget.js";
import { describeActivity } from "./agent-widget.js";

type SessionLike = { messages: any[] };

export interface BuildContentLinesArgs {
  session?: SessionLike;
  record?: Pick<AgentRecord, "status">;
  activity?: AgentActivity;
  theme: Theme;
  width: number;
  emptyMessage?: string;
}

/** Build width-clamped transcript lines for a session, including running activity. */
export function buildConversationContentLines({
  session,
  record,
  activity,
  theme,
  width,
  emptyMessage = "(waiting for first message...)",
}: BuildContentLinesArgs): string[] {
  if (width <= 0) return [];

  const messages = session?.messages ?? [];
  const lines: string[] = [];

  if (messages.length === 0) {
    lines.push(theme.fg("dim", emptyMessage));
    return lines.map(l => truncateToWidth(l, width));
  }

  let needsSeparator = false;
  for (const msg of messages) {
    if (msg.role === "user") {
      const text = typeof msg.content === "string"
        ? msg.content
        : extractText(msg.content);
      if (!text.trim()) continue;
      if (needsSeparator) lines.push(theme.fg("dim", "───"));
      lines.push(theme.fg("accent", "[User]"));
      for (const line of wrapTextWithAnsi(text.trim(), width)) {
        lines.push(line);
      }
    } else if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: string[] = [];
      for (const c of msg.content) {
        if (c.type === "text" && c.text) textParts.push(c.text);
        else if (c.type === "toolCall") {
          toolCalls.push((c as any).name ?? (c as any).toolName ?? "unknown");
        }
      }
      if (needsSeparator) lines.push(theme.fg("dim", "───"));
      lines.push(theme.bold("[Assistant]"));
      if (textParts.length > 0) {
        for (const line of wrapTextWithAnsi(textParts.join("\n").trim(), width)) {
          lines.push(line);
        }
      }
      for (const name of toolCalls) {
        lines.push(truncateToWidth(theme.fg("muted", `  [Tool: ${name}]`), width));
      }
    } else if (msg.role === "toolResult") {
      const text = extractText(msg.content);
      const truncated = text.length > 500 ? text.slice(0, 500) + "... (truncated)" : text;
      if (!truncated.trim()) continue;
      if (needsSeparator) lines.push(theme.fg("dim", "───"));
      lines.push(theme.fg("dim", "[Result]"));
      for (const line of wrapTextWithAnsi(truncated.trim(), width)) {
        lines.push(theme.fg("dim", line));
      }
    } else if ((msg as any).role === "bashExecution") {
      const bash = msg as any;
      if (needsSeparator) lines.push(theme.fg("dim", "───"));
      lines.push(truncateToWidth(theme.fg("muted", `  $ ${bash.command}`), width));
      if (bash.output?.trim()) {
        const out = bash.output.length > 500
          ? bash.output.slice(0, 500) + "... (truncated)"
          : bash.output;
        for (const line of wrapTextWithAnsi(out.trim(), width)) {
          lines.push(theme.fg("dim", line));
        }
      }
    } else {
      continue;
    }
    needsSeparator = true;
  }

  if (record?.status === "running" && activity) {
    const act = describeActivity(activity.activeTools, activity.responseText);
    lines.push("");
    lines.push(truncateToWidth(theme.fg("accent", "▍ ") + theme.fg("dim", act), width));
  }

  return lines.map(l => truncateToWidth(l, width));
}
