import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Turn } from "@microsoft/agent-host-protocol";
import { historyTurns, type HistoryMessage } from "../history.js";

const fixture = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "session-context.json"), "utf8"),
) as HistoryMessage[];

describe("turn history hydration", () => {
  const turns = historyTurns(fixture);

  it("rebuilds one turn per finished user message, in order, with how it ended", () => {
    expect(turns.map((t) => [t.message.text, t.state])).toEqual([
      ["Run the shell command 'ls -la' with your bash tool, then reply with the number of entries.", "complete"],
      ["Now read README.md with your read tool and quote it.", "complete"],
      ["Run the bash command: sleep 30 && echo finished", "cancelled"],
    ]);
    expect(new Set(turns.map((t) => t.id)).size).toBe(turns.length);
    expect(turns.every((t) => t.id.startsWith("hist_msg_"))).toBe(true);
  });

  it("maps tool calls, reasoning and text as the live pump does", () => {
    const [first, second, third] = turns as [Turn, Turn, Turn];
    const tool = first.responseParts[0];
    expect(tool).toMatchObject({
      kind: "toolCall",
      toolCall: { toolName: "shell", displayName: "Shell", status: "completed", success: true, invocationMessage: "Run `ls -la`", pastTenseMessage: "Ran `ls -la`" },
    });
    expect(first.responseParts.map((p) => p.kind)).toEqual(["toolCall", "reasoning", "markdown"]);
    expect(second.responseParts.at(-1)).toMatchObject({ kind: "markdown", content: "README.md contains:\n\n> hello" });
    expect(third.responseParts.find((p) => p.kind === "toolCall")).toMatchObject({ toolCall: { status: "cancelled" } });
  });

  it("leaves a turn that has not ended to the live pump", () => {
    const running = historyTurns([...fixture, { id: "msg_new", type: "user", text: "still going" }]);
    expect(running).toHaveLength(turns.length);
  });

  it("ignores what it cannot hang on a turn", () => {
    expect(historyTurns([{ id: "a", type: "assistant", content: [{ type: "text", text: "orphan" }] }, { id: "b", type: "idle", outcome: "succeeded" }])).toEqual([]);
  });
});

describe("hydration on registration", () => {
  it("loads the finished turns of a session the host did not create, once, and leaves later turns to the live pump", async () => {
    const { makeHarness, waitInit, waitFor, chatSnapshotState } = await import("./host-fakes.js");
    const { chatChannelURI } = await import("../channels.js");
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const t0 = Date.now() - 60_000;
    h.facade.sessions.set("ses_tui", { sessionID: "ses_tui", title: "TUI", time: { created: t0, updated: t0 } });
    const past = fixture.map((m) => ({ ...m, time: { created: t0 + 1 } }));
    // a turn that began after the host registered the session is the live pump's, never history's
    const later = [{ id: "msg_late", type: "user", text: "later", time: { created: Date.now() + 60_000 } }, { id: "msg_late_idle", type: "idle", outcome: "succeeded" }];
    h.facade.histories.set("ses_tui", [...past, ...later]);
    h.send(1, "listSessions", {}, 200);
    await waitFor(() => h.frames.some((f) => f.message.id === 200), "listSessions");
    const chat = chatChannelURI("ses_tui");
    let turns: Turn[] = [];
    for (let i = 0; i < 50 && turns.length === 0; i++) {
      turns = (await chatSnapshotState(h, 1, chat, 300 + i)).turns;
      if (turns.length === 0) await new Promise((r) => setTimeout(r, 20));
    }
    expect(turns.map((t) => t.message.text)).toEqual(historyTurns(past).map((t) => t.message.text));
    h.stop();
  });
});
