/**
 * Turn history hydration: a session's past turns, rebuilt from opencode's
 * own durable store (`ctx.session.context`, the persisted message window),
 * so a chat keeps its history across a location reload or a server
 * restart, and an externally created session (the TUI's) shows the turns
 * it had before the host registered it. The live pump only sees turns
 * that run while the host is up; this is the rest (design §15, futures
 * §1.3).
 *
 * Pure: messages in, AHP `Turn`s out. A user message opens a turn; the
 * assistant messages after it give its response parts (reasoning,
 * markdown, tool calls — mapped with the same helpers as the live pump);
 * the `idle` marker that follows gives how it ended. A turn with no
 * `idle` yet is still running and is left to the live pump.
 */
import type { ResponsePart, Turn } from "@microsoft/agent-host-protocol";
import { ResponsePartKind, ToolCallStatus, TurnState, MessageKind } from "@microsoft/agent-host-protocol";
import { displayNameFor, invocationMessageFor, pastTenseMessageFor } from "./bridge.js";
import { mapToolResultContent } from "./host-util.js";

/** The shape of one durable opencode message this module reads (`SessionMessage.Info`). */
export interface HistoryMessage {
  id: string;
  type: string;
  text?: string;
  outcome?: string;
  time?: { created?: number };
  metadata?: Record<string, unknown>;
  content?: readonly HistoryPart[];
}

export interface HistoryPart {
  type: string;
  id?: string;
  text?: string;
  name?: string;
  state?: {
    status?: string;
    input?: unknown;
    content?: readonly { type: string; text?: string }[];
    error?: { message?: string };
  };
}

/** The id a hydrated turn gets: stable, so loading twice never duplicates. */
export function historyTurnId(messageID: string): string {
  return `hist_${messageID}`;
}

function stateOf(outcome: string | undefined): TurnState {
  switch (outcome) {
    case "interrupted":
      return TurnState.Cancelled;
    case "failed":
      return TurnState.Error;
    default:
      return TurnState.Complete;
  }
}

function toolPart(part: HistoryPart): ResponsePart | null {
  const name = part.name ?? "tool";
  const id = part.id ?? "";
  if (id === "") return null;
  const inputText = part.state?.input === undefined ? undefined : JSON.stringify(part.state.input);
  const base = {
    toolCallId: id,
    toolName: name,
    displayName: displayNameFor(name),
    invocationMessage: invocationMessageFor(name, inputText),
    ...(inputText !== undefined ? { toolInput: inputText } : {}),
  };
  const status = part.state?.status;
  if (status === "completed") {
    return {
      kind: ResponsePartKind.ToolCall,
      toolCall: {
        ...base,
        status: ToolCallStatus.Completed,
        success: true,
        pastTenseMessage: pastTenseMessageFor(name, inputText),
        content: mapToolResultContent(part.state?.content ?? []),
      },
    } as ResponsePart;
  }
  if (status === "error") {
    const aborted = /interrupt|abort/i.test(part.state?.error?.message ?? "");
    if (aborted) {
      return {
        kind: ResponsePartKind.ToolCall,
        toolCall: { ...base, status: ToolCallStatus.Cancelled, reason: "denied", reasonMessage: part.state?.error?.message ?? "interrupted" },
      } as unknown as ResponsePart;
    }
    return {
      kind: ResponsePartKind.ToolCall,
      toolCall: {
        ...base,
        status: ToolCallStatus.Completed,
        success: false,
        pastTenseMessage: pastTenseMessageFor(name, inputText),
        error: { message: part.state?.error?.message ?? "failed" },
      },
    } as ResponsePart;
  }
  return null; // a call that never finished: nothing durable to show
}

/** The finished turns of a session's durable messages, oldest first. */
export function historyTurns(messages: readonly HistoryMessage[]): Turn[] {
  const turns: Turn[] = [];
  let open: { turn: Turn; partIndex: number } | null = null;
  for (const m of messages) {
    if (m.type === "user") {
      open = {
        turn: {
          id: historyTurnId(m.id),
          ...(m.time?.created !== undefined ? { startedAt: new Date(m.time.created).toISOString() } : {}),
          message: { text: m.text ?? "", origin: { kind: MessageKind.User } },
          responseParts: [],
          usage: undefined,
          state: TurnState.Complete,
        },
        partIndex: 0,
      };
      continue;
    }
    if (open === null) continue; // assistant output before any user message: nothing to hang it on
    if (m.type === "assistant") {
      for (const part of m.content ?? []) {
        const n = open.partIndex++;
        if (part.type === "text" && (part.text ?? "") !== "") {
          open.turn.responseParts.push({ kind: ResponsePartKind.Markdown, id: `hist-${m.id}-${n}`, content: part.text ?? "" });
        } else if (part.type === "reasoning" && (part.text ?? "") !== "") {
          open.turn.responseParts.push({ kind: ResponsePartKind.Reasoning, id: `hist-${m.id}-${n}`, content: part.text ?? "" });
        } else if (part.type === "tool") {
          const tool = toolPart(part);
          if (tool !== null) open.turn.responseParts.push(tool);
        }
      }
      continue;
    }
    if (m.type === "idle") {
      open.turn.state = stateOf(m.outcome);
      turns.push(open.turn);
      open = null;
    }
  }
  return turns;
}
