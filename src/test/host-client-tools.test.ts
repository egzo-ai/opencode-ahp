/**
 * Host tests — client-provided tools: registration through the session
 * snapshot, the cross-session union the facade sees, and the tool-call round
 * trips (contributor execution, result confirmation, failure and disconnect
 * handling).
 */
import { describe, expect, it } from "vitest";
import { SessionStatus, ToolCallStatus } from "@microsoft/agent-host-protocol";
import { sessionChannelURI, chatChannelURI } from "../channels.js";
import {
  waitFor,
  Harness,
  makeHarness,
  waitInit,
  createSession,
  subscribe,
  sessionSnapshotState,
  chatSnapshotState,
  waitForAction,
} from "./host-fakes.js";

// ── client tools ───────────────────────

describe("client tools", () => {
  const SES = "ses_ct";
  const CHAT = chatChannelURI(SES);
  const SC = sessionChannelURI(SES);

  /**
   * Common setup: c1 creates a session whose active client provides the
   * tool "ct", subscribes to both channels, and starts a turn.
   */
  async function setup(h: Harness): Promise<void> {
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, SC, {
      provider: "gpuz",
      activeClient: { clientId: "c1", tools: [{ name: "ct" }] },
    });
    await subscribe(h, 1, SC, 110);
    await subscribe(h, 1, CHAT, 111);
    h.send(1, "dispatchAction", {
      channel: CHAT,
      clientSeq: 1,
      action: {
        type: "chat/turnStarted",
        turnId: "t1",
        startedAt: new Date().toISOString(),
        message: { text: "call the ct tool", origin: { kind: "user" } },
      },
    });
    await waitFor(() => h.facade.promptCalls.length === 1, "prompt");
  }

  /** Pump the client-tool input cycle (started + ended) for one call id. */
  function pushInputCycle(h: Harness, toolCallId: string, name = "ct"): void {
    h.facade.push({ type: "tool.input.started", sessionID: SES, assistantMessageID: "msg_ct", id: toolCallId, name });
    h.facade.push({ type: "tool.input.ended", sessionID: SES, assistantMessageID: "msg_ct", id: toolCallId, text: "{}" });
  }

  /** End the turn (after the opencode-side terminal for the call). */
  async function endTurn(h: Harness): Promise<void> {
    h.facade.push({ type: "execution.succeeded", sessionID: SES });
    await waitForAction(h, CHAT, "chat/turnComplete");
  }

  it("createSession with activeClient.tools registers the opencode tool union", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, SC, {
      provider: "gpuz",
      activeClient: {
        clientId: "c1",
        tools: [
          { name: "ct", description: "Client tool", inputSchema: { type: "object", properties: { n: { type: "string" } }, required: ["n"] } },
          { name: "bad" },
          { title: "no name" }, // dropped by wire validation
        ],
      },
    });
    await waitFor(() => h.facade.syncClientToolsCalls.length === 1, "syncClientTools");
    expect(h.facade.syncClientToolsCalls[0]).toEqual([
      { name: "ct", description: "Client tool", inputSchema: { type: "object", properties: { n: { type: "string" } }, required: ["n"] } },
      { name: "bad", description: "bad", inputSchema: { type: "object" } },
    ]);
    h.stop();
  });

  it("session/activeClientSet re-syncs the cross-session union (first-registered wins)", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, SC, { provider: "gpuz" }, 100);
    const SES2 = "ses_ct2";
    // Distinct RPC ids: the second await must match its own response,
    // not the first session's (both are `result: null`).
    await createSession(h, 1, sessionChannelURI(SES2), { provider: "gpuz" }, 101);
    h.send(1, "dispatchAction", {
      channel: SC,
      clientSeq: 1,
      action: {
        type: "session/activeClientSet",
        activeClient: { clientId: "c1", tools: [{ name: "a" }, { name: "dup", description: "first" }] },
      },
    });
    await waitFor(() => h.facade.syncClientToolsCalls.length === 1, "sync 1");
    h.send(1, "dispatchAction", {
      channel: sessionChannelURI(SES2),
      clientSeq: 2,
      action: {
        type: "session/activeClientSet",
        activeClient: { clientId: "c1", tools: [{ name: "b" }, { name: "dup", description: "second" }] },
      },
    });
    await waitFor(() => h.facade.syncClientToolsCalls.length === 2, "sync 2");
    expect(h.facade.syncClientToolsCalls[0]!.map((t) => t.name)).toEqual(["a", "dup"]);
    const union = h.facade.syncClientToolsCalls[1]!;
    expect(union.map((t) => t.name)).toEqual(["a", "dup", "b"]);
    expect(union.find((t) => t.name === "dup")?.description).toBe("first");
    h.stop();
  });

  it("client-executed tool: contributor at start, ready + execution request, client complete settles the execute", async () => {
    const h = makeHarness();
    await setup(h);
    pushInputCycle(h, "tool_1");

    const start = await waitForAction(h, CHAT, "chat/toolCallStart");
    expect(start.action.contributor).toEqual({ kind: "client", clientId: "c1" });

    const ready = await waitForAction(h, CHAT, "chat/toolCallReady");
    expect(ready.action.toolCallId).toBe("tool_1");
    expect(ready.action.confirmed).toBe("not-needed");

    const needed = await waitForAction(h, SC, "session/inputNeededSet");
    expect(needed.action.request).toMatchObject({
      id: "tool_1",
      chat: CHAT,
      kind: "toolClientExecution",
      turnId: "t1",
      clientId: "c1",
    });
    expect(needed.action.request.toolCall.status).toBe("running");

    // The execution request does not raise InputNeeded — the turn stays
    // in progress while the client runs (chat summary; the session-level
    // status only carries the input-queue activity bits).
    const sess = await sessionSnapshotState(h, 1, SC, 112);
    expect(sess.status & SessionStatus.InputNeeded).toBe(0);
    expect(sess.chats[0]!.status & SessionStatus.InProgress).toBe(SessionStatus.InProgress);

    // The opencode execute bridge blocks until the client completes.
    const exec = h.host.executeClientTool({ sessionID: SES, toolCallId: "tool_1", name: "ct", signal: new AbortController().signal });

    // The client may stream partial content while running (echo only).
    h.send(1, "dispatchAction", {
      channel: CHAT,
      clientSeq: 2,
      action: { type: "chat/toolCallContentChanged", turnId: "t1", toolCallId: "tool_1", content: [{ type: "text", text: "working…" }] },
    });
    const changed = await waitForAction(h, CHAT, "chat/toolCallContentChanged");
    expect(changed.rejectionReason).toBeUndefined();

    // The client completes.
    h.send(1, "dispatchAction", {
      channel: CHAT,
      clientSeq: 3,
      action: {
        type: "chat/toolCallComplete",
        turnId: "t1",
        toolCallId: "tool_1",
        result: { success: true, pastTenseMessage: "Pinged the service", content: [{ type: "text", text: "pong" }] },
      },
    });
    const complete = await waitForAction(h, CHAT, "chat/toolCallComplete");
    expect(complete.rejectionReason).toBeUndefined();
    await waitForAction(h, SC, "session/inputNeededRemoved");

    const execResult = await exec;
    expect(execResult).toEqual({ ok: true, pastTenseMessage: "Pinged the service", content: "pong" });

    // The opencode-side terminal arrives: no duplicate complete (queue
    // order — turnComplete is processed after tool.success).
    h.facade.push({ type: "tool.success", sessionID: SES, id: "tool_1", content: [{ type: "text", text: "pong" }] });
    await endTurn(h);
    expect(h.actionsOn(CHAT).filter((a) => a.action.type === "chat/toolCallComplete")).toHaveLength(1);

    // The tracking is gone: a second execute for the same call is refused.
    const exec2 = await h.host.executeClientTool({ sessionID: SES, toolCallId: "tool_1", name: "ct", signal: new AbortController().signal });
    expect(exec2.ok).toBe(false);

    // The completed tool call carries the client's result.
    const chat = await chatSnapshotState(h, 1, CHAT, 113);
    const part = (chat.turns[0]!.responseParts.find((p) => (p as any).kind === "toolCall") as any).toolCall;
    expect(part.status).toBe(ToolCallStatus.Completed);
    expect(part.contributor).toEqual({ kind: "client", clientId: "c1" });
    expect(part.success).toBe(true);
    expect(part.pastTenseMessage).toBe("Pinged the service");
    expect(part.content).toEqual([{ type: "text", text: "pong" }]);
    h.stop();
  }, 15000);

  it("rejects complete/contentChanged from a non-contributing client and for non-client calls", async () => {
    const h = makeHarness();
    await setup(h);
    h.init(2, "c2");
    await waitInit(h, 2);
    await subscribe(h, 2, CHAT, 121);
    pushInputCycle(h, "tool_1");
    await waitForAction(h, CHAT, "chat/toolCallStart");

    // c2 is not the contributor.
    h.send(2, "dispatchAction", {
      channel: CHAT,
      clientSeq: 1,
      action: { type: "chat/toolCallComplete", turnId: "t1", toolCallId: "tool_1", result: { success: true, pastTenseMessage: "x" } },
    });
    const rejected = await waitForAction(h, CHAT, "chat/toolCallComplete", (a) => a.rejectionReason !== undefined);
    expect(rejected.rejectionReason).toMatch(/contributing client/);

    // A server-executed call cannot be completed by the client at all.
    h.facade.push({ type: "tool.input.started", sessionID: SES, assistantMessageID: "msg_ct", id: "tool_2", name: "shell" });
    h.facade.push({ type: "tool.input.ended", sessionID: SES, assistantMessageID: "msg_ct", id: "tool_2", text: "{}" });
    h.send(1, "dispatchAction", {
      channel: CHAT,
      clientSeq: 4,
      action: { type: "chat/toolCallComplete", turnId: "t1", toolCallId: "tool_2", result: { success: true, pastTenseMessage: "x" } },
    });
    const rejected2 = await waitForAction(h, CHAT, "chat/toolCallComplete", (a) => a.action.toolCallId === "tool_2" && a.rejectionReason !== undefined);
    expect(rejected2.rejectionReason).toMatch(/not a client-executed call/);
    h.stop();
  });

  it("requiresResultConfirmation holds the result, raises InputNeeded, and settles on approval", async () => {
    const h = makeHarness();
    await setup(h);
    pushInputCycle(h, "tool_1");
    await waitForAction(h, SC, "session/inputNeededSet");

    const exec = h.host.executeClientTool({ sessionID: SES, toolCallId: "tool_1", name: "ct", signal: new AbortController().signal });
    h.send(1, "dispatchAction", {
      channel: CHAT,
      clientSeq: 2,
      action: {
        type: "chat/toolCallComplete",
        turnId: "t1",
        toolCallId: "tool_1",
        requiresResultConfirmation: true,
        result: { success: true, pastTenseMessage: "Did a thing", content: [{ type: "text", text: "thing" }] },
      },
    });
    await waitForAction(h, CHAT, "chat/toolCallComplete");

    // The confirmation request (same id — upserts over the execution
    // request) is user-facing: it raises InputNeeded.
    const confirm = await waitForAction(h, SC, "session/inputNeededSet", (a) => a.action.request.kind === "toolConfirmation");
    expect(confirm.action.request.toolCall.status).toBe("pending-result-confirmation");
    const sess = await sessionSnapshotState(h, 1, SC, 112);
    expect(sess.status & SessionStatus.InputNeeded).toBe(SessionStatus.InputNeeded);

    // The user approves → the held result settles the execute.
    h.send(1, "dispatchAction", {
      channel: CHAT,
      clientSeq: 3,
      action: { type: "chat/toolCallResultConfirmed", turnId: "t1", toolCallId: "tool_1", approved: true },
    });
    await waitForAction(h, CHAT, "chat/toolCallResultConfirmed");
    await waitForAction(h, SC, "session/inputNeededRemoved");
    const execResult = await exec;
    expect(execResult).toEqual({ ok: true, pastTenseMessage: "Did a thing", content: "thing" });

    // The queue drained: no longer blocked (the turn is still active, so
    // the status falls back to InProgress per the official reducer).
    const cleared = await sessionSnapshotState(h, 1, SC, 113);
    expect(cleared.status & SessionStatus.InputNeeded).not.toBe(SessionStatus.InputNeeded);
    expect(cleared.status & SessionStatus.InProgress).toBe(SessionStatus.InProgress);
    h.facade.push({ type: "tool.success", sessionID: SES, id: "tool_1", content: [{ type: "text", text: "thing" }] });
    await endTurn(h);
    expect(h.actionsOn(CHAT).filter((a) => a.action.type === "chat/toolCallComplete")).toHaveLength(1);
    h.stop();
  }, 15000);

  it("a denied result confirmation settles the execute with an error and cancels the call", async () => {
    const h = makeHarness();
    await setup(h);
    pushInputCycle(h, "tool_1");
    await waitForAction(h, SC, "session/inputNeededSet");

    const exec = h.host.executeClientTool({ sessionID: SES, toolCallId: "tool_1", name: "ct", signal: new AbortController().signal });
    h.send(1, "dispatchAction", {
      channel: CHAT,
      clientSeq: 2,
      action: {
        type: "chat/toolCallComplete",
        turnId: "t1",
        toolCallId: "tool_1",
        requiresResultConfirmation: true,
        result: { success: true, pastTenseMessage: "Did a thing" },
      },
    });
    await waitForAction(h, SC, "session/inputNeededSet", (a) => a.action.request.kind === "toolConfirmation");

    h.send(1, "dispatchAction", {
      channel: CHAT,
      clientSeq: 3,
      action: { type: "chat/toolCallResultConfirmed", turnId: "t1", toolCallId: "tool_1", approved: false },
    });
    await waitForAction(h, CHAT, "chat/toolCallResultConfirmed");
    const execResult = await exec;
    expect(execResult).toEqual({ ok: false, error: "the client denied the tool result" });

    h.facade.push({ type: "tool.failed", sessionID: SES, id: "tool_1", error: { type: "Error", message: "the client denied the tool result" } });
    await endTurn(h);
    const chat = await chatSnapshotState(h, 1, CHAT, 112);
    const part = (chat.turns[0]!.responseParts.find((p) => (p as any).kind === "toolCall") as any).toolCall;
    expect(part.status).toBe(ToolCallStatus.Cancelled);
    expect(part.reason).toBe("result-denied");
    h.stop();
  }, 15000);

  it("a failed client result settles the execute with the client's error", async () => {
    const h = makeHarness();
    await setup(h);
    pushInputCycle(h, "tool_1");
    await waitForAction(h, SC, "session/inputNeededSet");

    const exec = h.host.executeClientTool({ sessionID: SES, toolCallId: "tool_1", name: "ct", signal: new AbortController().signal });
    h.send(1, "dispatchAction", {
      channel: CHAT,
      clientSeq: 2,
      action: {
        type: "chat/toolCallComplete",
        turnId: "t1",
        toolCallId: "tool_1",
        result: { success: false, pastTenseMessage: "Tried the service", error: { message: "boom" } },
      },
    });
    await waitForAction(h, CHAT, "chat/toolCallComplete");
    const execResult = await exec;
    expect(execResult).toEqual({ ok: false, error: "boom" });

    h.facade.push({ type: "tool.failed", sessionID: SES, id: "tool_1", error: { type: "Error", message: "boom" } });
    await endTurn(h);
    expect(h.actionsOn(CHAT).filter((a) => a.action.type === "chat/toolCallComplete")).toHaveLength(1);
    h.stop();
  }, 15000);

  it("an aborted signal fails the in-flight execute (turn interrupt)", async () => {
    const h = makeHarness();
    await setup(h);
    pushInputCycle(h, "tool_1");
    await waitForAction(h, SC, "session/inputNeededSet");

    const ac = new AbortController();
    const exec = h.host.executeClientTool({ sessionID: SES, toolCallId: "tool_1", name: "ct", signal: ac.signal });
    ac.abort();
    const execResult = await exec;
    expect(execResult.ok).toBe(false);
    if (!execResult.ok) expect(execResult.error).toMatch(/cancelled/);
    h.stop();
  });

  it("executeClientTool refuses non-AHP sessions and unknown calls", async () => {
    const h = makeHarness();
    const r1 = await h.host.executeClientTool({ sessionID: "ses_nope", toolCallId: "x", name: "ct", signal: new AbortController().signal });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toMatch(/not an AHP session/);

    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, SC, { provider: "gpuz", activeClient: { clientId: "c1", tools: [{ name: "ct" }] } });
    const r2 = await h.host.executeClientTool({ sessionID: SES, toolCallId: "nope", name: "ct", signal: new AbortController().signal });
    expect(r2.ok).toBe(false);
    h.stop();
  });

  it("disconnect evicts the active client, fails the in-flight call, and re-syncs the union", async () => {
    const h = makeHarness();
    await setup(h);
    pushInputCycle(h, "tool_1");
    await waitForAction(h, SC, "session/inputNeededSet");

    const exec = h.host.executeClientTool({ sessionID: SES, toolCallId: "tool_1", name: "ct", signal: new AbortController().signal });
    const syncsBefore = h.facade.syncClientToolsCalls.length;
    h.host.onClose(1);

    // Server-side eviction on the session channel.
    expect(h.actionsOn(SC).some((a) => a.action.type === "session/activeClientRemoved" && a.action.clientId === "c1")).toBe(true);
    // The union shrank → re-synced.
    await waitFor(() => h.facade.syncClientToolsCalls.length > syncsBefore, "re-sync after eviction");
    expect(h.facade.syncClientToolsCalls[h.facade.syncClientToolsCalls.length - 1]).toEqual([]);
    // The in-flight execution request is cleared from the session state.
    const removed = h.actionsOn(SC).find((a) => a.action.type === "session/inputNeededRemoved");
    expect(removed?.action.id).toBe("tool_1");
    // The in-flight execution fails with a disconnect error.
    const execResult = await exec;
    expect(execResult).toEqual({ ok: false, error: "client c1 disconnected before completing the tool call" });
    h.stop();
  });

  it("disconnect evicts a held-result confirmation and clears the session input request", async () => {
    const h = makeHarness();
    await setup(h);
    pushInputCycle(h, "tool_1");
    await waitForAction(h, SC, "session/inputNeededSet");

    const exec = h.host.executeClientTool({ sessionID: SES, toolCallId: "tool_1", name: "ct", signal: new AbortController().signal });
    h.send(1, "dispatchAction", {
      channel: CHAT,
      clientSeq: 2,
      action: {
        type: "chat/toolCallComplete",
        turnId: "t1",
        toolCallId: "tool_1",
        requiresResultConfirmation: true,
        result: { success: true, pastTenseMessage: "Did a thing" },
      },
    });
    // The host upserts the same request id as a toolConfirmation → the
    // session is InputNeeded while the result awaits approval.
    await waitForAction(h, SC, "session/inputNeededSet", (a) => a.action.request.kind === "toolConfirmation");
    const blocked = await sessionSnapshotState(h, 1, SC, 120);
    expect(blocked.status & SessionStatus.InputNeeded).toBe(SessionStatus.InputNeeded);

    // The client disconnects while the result is held.
    h.host.onClose(1);

    // The stale confirmation request is removed and the session unblocks
    // (without this the session sits in InputNeeded forever). A second
    // client observes the cleared state (socket 1 is gone).
    await waitForAction(h, SC, "session/inputNeededRemoved", (a) => a.action.id === "tool_1");
    h.init(2, "c2");
    await waitInit(h, 2);
    const cleared = await sessionSnapshotState(h, 2, SC, 121);
    expect(cleared.status & SessionStatus.InputNeeded).not.toBe(SessionStatus.InputNeeded);
    expect(cleared.inputNeeded ?? []).toHaveLength(0);
    // The held execution fails with a disconnect error.
    const execResult = await exec;
    expect(execResult).toEqual({ ok: false, error: "client c1 disconnected before completing the tool call" });
    h.stop();
  }, 15000);
});
