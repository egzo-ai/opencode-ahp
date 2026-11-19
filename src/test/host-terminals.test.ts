/**
 * Host tests — terminals: the synthetic shell-tool renderings and the pty
 * surface (`createTerminal`/`disposeTerminal` over the `spawnPty` seam,
 * cwd resolution and clamping).
 */
import { describe, expect, it } from "vitest";
import { directoryUri } from "../bridge.js";
import {
  ROOT_CHANNEL,
  sessionChannelURI,
  chatChannelURI,
  terminalChannelURI,
} from "../channels.js";
import {
  waitFor,
  Harness,
  makeHarness,
  waitInit,
  createSession,
  subscribe,
  DIR,
  OTHER,
  startTurn,
  waitForAction,
} from "./host-fakes.js";

// ── terminals ─────────────

describe("terminals", () => {
  const SES = "ses_term";
  const TOOL = "tool_term_1";

  /** Open a session, start a turn, and open the synthetic terminal for TOOL. */
  async function openShellTerminal(h: Harness, command = "echo hello-ahp", input = JSON.stringify({ command })) {
    const sessionURI = sessionChannelURI(SES);
    const chatURI = chatChannelURI(SES);
    await createSession(h, 1, sessionURI, { provider: "gpuz" });
    await subscribe(h, 1, chatURI, 801);
    startTurn(h, chatURI, "tT", 1, "run a command");
    await waitFor(() => h.facade.promptCalls.length === 1, "prompt");
    h.facade.push({ type: "tool.input.started", sessionID: SES, assistantMessageID: "msg_1", id: TOOL, name: "shell" });
    h.facade.push({ type: "tool.input.ended", sessionID: SES, assistantMessageID: "msg_1", id: TOOL, text: input });
    await waitFor(() => h.actionsOn(ROOT_CHANNEL).some((a) => a.action.type === "root/terminalsChanged"), "terminalsChanged");
    return { sessionURI, chatURI, terminalURI: terminalChannelURI(TOOL) };
  }

  function lastCatalog(h: Harness): any[] {
    const actions = h.actionsOn(ROOT_CHANNEL).filter((a) => a.action.type === "root/terminalsChanged");
    return actions[actions.length - 1]!.action.terminals;
  }

  async function terminalSnapshotState(h: Harness, uri: string, id: number): Promise<Record<string, any>> {
    return subscribe(h, 1, uri, id).then((res) => res["result"]["snapshot"]["state"]);
  }

  /** Send `createTerminal` and wait for the JSON-RPC result. */
  async function createPtyTerminal(
    h: Harness,
    channel: string,
    params: Record<string, unknown> = {},
    id = 930,
  ): Promise<Record<string, any>> {
    h.send(1, "createTerminal", { channel, claim: { kind: "client", clientId: "c1" }, ...params }, id);
    await waitFor(() => h.frames.some((f) => f.message.id === id), `createTerminal response (${channel})`);
    return h.frames.find((f) => f.message.id === id)!.message;
  }

  it("opens a synthetic terminal for a shell call: catalog row, snapshot shape, and the full action stream", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const { sessionURI, chatURI, terminalURI } = await openShellTerminal(h);

    // Root catalog: one row, session claim scoped to chat/turn/tool call,
    // running lifecycle.
    const row = lastCatalog(h)[0]!;
    expect(row.resource).toBe(terminalURI);
    expect(row.title).toBe("echo hello-ahp");
    expect(row.claim).toEqual({ kind: "session", session: sessionURI, chat: chatURI, turnId: "tT", toolCallId: TOOL });
    expect(row.lifecycle).toEqual({ status: "running" });

    // Terminal snapshot: isPty: false, command-detection on, the
    // commandExecuted part, the location cwd.
    const state = await terminalSnapshotState(h, terminalURI, 810);
    expect(state.isPty).toBe(false);
    expect(state.supportsCommandDetection).toBe(true);
    expect(state.title).toBe("echo hello-ahp");
    expect(state.cwd).toBe(`file://${DIR}/`);
    expect(state.claim).toEqual(row.claim);
    expect(state.lifecycle).toEqual({ status: "running" });
    expect(state.content).toEqual([
      { type: "command", commandId: TOOL, commandLine: "echo hello-ahp", output: "", timestamp: expect.any(Number), isComplete: false },
    ]);

    // Completion: data → commandFinished (exitCode 0, duration) → exited.
    h.facade.push({ type: "tool.success", sessionID: SES, id: TOOL, content: [{ type: "text", text: "hello-ahp\n" }] });
    const finished = await waitForAction(h, terminalURI, "terminal/commandFinished");
    expect(finished.action.commandId).toBe(TOOL);
    expect(finished.action.exitCode).toBe(0);
    expect(finished.action.durationMs).toBeGreaterThanOrEqual(0);
    const exited = await waitForAction(h, terminalURI, "terminal/exited");
    expect(exited.action.exitCode).toBe(0);

    // The catalog row flips to the exited lifecycle while the turn runs.
    await waitFor(() => lastCatalog(h)[0]?.lifecycle.status === "exited", "catalog lifecycle flip");
    expect(lastCatalog(h)).toHaveLength(1);

    // Final state: the command part is complete in place.
    const done = await terminalSnapshotState(h, terminalURI, 811);
    expect(done.lifecycle).toEqual({ status: "exited", exitCode: 0 });
    expect(done.content[0]).toMatchObject({ type: "command", commandId: TOOL, isComplete: true, exitCode: 0, output: "hello-ahp\n", durationMs: expect.any(Number) });

    // Retention: the turn end drops the catalog row, but the channel
    // state stays subscribable (the chat still owns it).
    h.facade.push({ type: "execution.succeeded", sessionID: SES });
    await waitForAction(h, chatURI, "chat/turnComplete");
    await waitFor(() => lastCatalog(h).length === 0, "catalog drop at turn end");
    const retained = await terminalSnapshotState(h, terminalURI, 812);
    expect(retained.lifecycle).toEqual({ status: "exited", exitCode: 0 });
    h.stop();
  });

  it("parses a non-zero exit from the result notice; failures carry the error text and no exit code", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const { terminalURI } = await openShellTerminal(h, "false", JSON.stringify({ command: "false" }));
    // Subscribe to the terminal channel — host-originated terminal actions
    // only reach subscribers (rejections are the write-ahead exception).
    await subscribe(h, 1, terminalURI, 820);
    h.facade.push({
      type: "tool.success",
      sessionID: SES,
      id: TOOL,
      content: [{ type: "text", text: "boom" }, { type: "text", text: "Exit code: 2" }],
    });
    const finished = await waitForAction(h, terminalURI, "terminal/commandFinished");
    expect(finished.action.exitCode).toBe(2);
    const data = await waitForAction(h, terminalURI, "terminal/data");
    expect(data.action.data).toBe("boom\nExit code: 2");
    h.stop();

    const h2 = makeHarness();
    h2.init(1, "c1");
    await waitInit(h2, 1);
    const { terminalURI: failedURI } = await openShellTerminal(h2, "nope", JSON.stringify({ command: "nope" }));
    await subscribe(h2, 1, failedURI, 821);
    h2.facade.push({ type: "tool.failed", sessionID: SES, id: TOOL, error: { type: "error", message: "Command failed" } });
    const failedFinished = await waitForAction(h2, failedURI, "terminal/commandFinished");
    expect(failedFinished.action.exitCode).toBeUndefined();
    const failedData = await waitForAction(h2, failedURI, "terminal/data");
    expect(failedData.action.data).toBe("Command failed");
    const failedExited = await waitForAction(h2, failedURI, "terminal/exited");
    expect(failedExited.action.exitCode).toBeUndefined();
    h2.stop();
  });

  it("excludes background shell calls and non-shell tools", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const { chatURI } = await openShellTerminal(h);
    // A background call and a non-shell tool follow in the same turn —
    // neither opens a terminal (the catalog keeps its single row).
    h.facade.push({ type: "tool.input.started", sessionID: SES, assistantMessageID: "msg_2", id: "tool_bg", name: "shell" });
    h.facade.push({
      type: "tool.input.ended",
      sessionID: SES,
      assistantMessageID: "msg_2",
      id: "tool_bg",
      text: JSON.stringify({ command: "sleep 60", background: true }),
    });
    h.facade.push({ type: "tool.input.started", sessionID: SES, assistantMessageID: "msg_3", id: "tool_read", name: "read" });
    h.facade.push({ type: "tool.input.ended", sessionID: SES, assistantMessageID: "msg_3", id: "tool_read", text: JSON.stringify({ path: "x" }) });
    await new Promise((r) => setTimeout(r, 50)); // let the pump drain
    expect(h.actionsOn(ROOT_CHANNEL).filter((a) => a.action.type === "root/terminalsChanged")).toHaveLength(1);
    expect(lastCatalog(h)).toHaveLength(1);
    h.facade.push({ type: "execution.succeeded", sessionID: SES });
    await waitForAction(h, chatURI, "chat/turnComplete");
    h.stop();
  });

  it("keeps every in-turn command listed (finished included) until the turn ends", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const { chatURI } = await openShellTerminal(h, "first");
    await subscribe(h, 1, terminalChannelURI(TOOL), 822);
    // A second command in the same turn joins the catalog.
    h.facade.push({ type: "tool.input.started", sessionID: SES, assistantMessageID: "msg_2", id: "tool_two", name: "shell" });
    h.facade.push({ type: "tool.input.ended", sessionID: SES, assistantMessageID: "msg_2", id: "tool_two", text: JSON.stringify({ command: "second" }) });
    await waitFor(() => lastCatalog(h).length === 2, "second catalog row");
    // First command finishes — it STAYS listed (exited lifecycle) until
    // the turn ends.
    h.facade.push({ type: "tool.success", sessionID: SES, id: TOOL, content: [{ type: "text", text: "a\n" }] });
    await waitForAction(h, terminalChannelURI(TOOL), "terminal/exited");
    await waitFor(() => lastCatalog(h).length === 2, "first row retained while running turn");
    const rows = lastCatalog(h);
    expect(rows.map((r: any) => r.lifecycle.status).sort()).toEqual(["exited", "running"]);
    h.facade.push({ type: "execution.succeeded", sessionID: SES });
    await waitForAction(h, chatURI, "chat/turnComplete");
    await waitFor(() => lastCatalog(h).length === 0, "both rows drop at turn end");
    h.stop();
  });

  it("rejects client-dispatchable terminal actions with a read-only reason (and unknown channels with no such terminal)", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const { terminalURI } = await openShellTerminal(h);
    const dispatch = (seq: number, action: Record<string, unknown>, uri: string = terminalURI) =>
      h.send(1, "dispatchAction", { channel: uri, clientSeq: seq, action });

    dispatch(1, { type: "terminal/input", data: "ls\n" });
    const input = await waitForAction(h, terminalURI, "terminal/input");
    expect(input.rejectionReason).toMatch(/read-only terminal/);
    dispatch(2, { type: "terminal/resized", cols: 80, rows: 24 });
    const resized = await waitForAction(h, terminalURI, "terminal/resized");
    expect(resized.rejectionReason).toMatch(/read-only terminal/);
    dispatch(3, { type: "terminal/claimed", claim: { kind: "client", clientId: "c1" } });
    const claimed = await waitForAction(h, terminalURI, "terminal/claimed");
    expect(claimed.rejectionReason).toMatch(/read-only terminal/);
    // A torn-down / never-opened channel gets the not-found reason.
    dispatch(4, { type: "terminal/input", data: "x" }, "ahp-terminal:/gone");
    const gone = await waitForAction(h, "ahp-terminal:/gone", "terminal/input");
    expect(gone.rejectionReason).toMatch(/no such terminal/);
    // The rejections never mutated the store.
    const state = await terminalSnapshotState(h, terminalURI, 813);
    expect(state.lifecycle).toEqual({ status: "running" });
    expect(state.claim.kind).toBe("session");
    h.stop();
  });

  // ── pty terminals (createTerminal / disposeTerminal) ────────────────

  describe("pty terminals", () => {
    const dispatch = (h: Harness, socketId: number, seq: number, action: Record<string, unknown>, uri: string) =>
      h.send(socketId, "dispatchAction", { channel: uri, clientSeq: seq, action });

    it("spawns a pty shell: result null, spawn input, catalog row, and the state snapshot", async () => {
      const h = makeHarness();
      h.init(1, "c1");
      await waitInit(h, 1);
      const res = await createPtyTerminal(h, "agenthost-terminal://t1", {
        name: "my shell",
        cwd: "file:///tmp/opencode/ahp-scratch/project-lan/sub",
        cols: 120,
        rows: 40,
      }, 940);
      expect(res.error).toBeUndefined();
      expect(res.result).toBeNull();

      // The pty was spawned with the resolved cwd and the requested size.
      expect(h.ptys).toHaveLength(1);
      expect(h.ptys[0]!.resizes[0]).toEqual({ cols: 120, rows: 40 });

      // Root catalog: one row, client claim, running lifecycle.
      await waitFor(() => lastCatalog(h).length === 1, "catalog row");
      const row = lastCatalog(h)[0]!;
      expect(row.resource).toBe("agenthost-terminal://t1");
      expect(row.title).toBe("my shell");
      expect(row.claim).toEqual({ kind: "client", clientId: "c1" });
      expect(row.lifecycle).toEqual({ status: "running" });

      // Snapshot: isPty, the directory cwd, size, no command detection.
      const state = await terminalSnapshotState(h, "agenthost-terminal://t1", 941);
      expect(state.isPty).toBe(true);
      expect(state.supportsCommandDetection).toBeUndefined();
      expect(state.title).toBe("my shell");
      expect(state.cwd).toBe("file:///tmp/opencode/ahp-scratch/project-lan/sub/");
      expect(state.cols).toBe(120);
      expect(state.rows).toBe(40);
      expect(state.claim).toEqual({ kind: "client", clientId: "c1" });
      expect(state.lifecycle).toEqual({ status: "running" });
      expect(state.content).toEqual([]);
      h.stop();
    });

    it("defaults to 80x24 and the location directory when cols/rows/cwd are omitted", async () => {
      const h = makeHarness();
      h.init(1, "c1");
      await waitInit(h, 1);
      const res = await createPtyTerminal(h, "agenthost-terminal://t-defaults", {}, 942);
      expect(res.error).toBeUndefined();
      expect(res.result).toBeNull();
      expect(h.ptys[0]!.resizes[0]).toEqual({ cols: 80, rows: 24 });
      const state = await terminalSnapshotState(h, "agenthost-terminal://t-defaults", 943);
      expect(state.title).toBe("Shell");
      expect(state.cwd).toBe(`file://${DIR}/`);
      expect(state.cols).toBe(80);
      expect(state.rows).toBe(24);
      h.stop();
    });

    it("resolves the cwd: subpaths stay, out-of-root clamps, wrapped and bare forms unwrap, malformed falls back", async () => {
      const cases: Array<{ label: string; cwd: string; expected: string }> = [
        { label: "file:// subpath", cwd: "file:///tmp/opencode/ahp-scratch/project-lan/src", expected: `${DIR}/src` },
        { label: "file:// outside the root", cwd: "file:///etc", expected: DIR },
        {
          label: "agent-host wrapper (URI path)",
          cwd: "vscode-agent-host://host/tmp/opencode/ahp-scratch/project-lan/deep",
          expected: `${DIR}/deep`,
        },
        {
          label: "agent-host wrapper (_ah meta wins)",
          cwd:
            "vscode-agent-host://host/ignored?" +
            "_ah=" +
            Buffer.from(JSON.stringify({ path: "/tmp/opencode/ahp-scratch/project-lan/from-meta" }), "utf8").toString("base64url"),
          expected: `${DIR}/from-meta`,
        },
        { label: "bare absolute path", cwd: "/tmp/opencode/ahp-scratch/project-lan/bare", expected: `${DIR}/bare` },
        { label: "malformed", cwd: "not-a-path", expected: DIR },
      ];
      for (let i = 0; i < cases.length; i++) {
        const h = makeHarness();
        h.init(1, "c1");
        await waitInit(h, 1);
        const channel = `agenthost-terminal://t-cwd-${i}`;
        const res = await createPtyTerminal(h, channel, { cwd: cases[i]!.cwd }, 944 + i);
        expect(res.error).toBeUndefined();
        expect(h.ptys[0]!.resizes).toBeDefined();
        // The spawn cwd is the resolved path (asserted via the record's state cwd).
        const state = await terminalSnapshotState(h, channel, 960 + i);
        expect(state.cwd, cases[i]!.label).toBe(`file://${cases[i]!.expected}/`);
        h.stop();
      }
    });

    it("client-claimed terminal opens in a live cross-location session's working directory", async () => {
      const h = makeHarness();
      h.init(1, "c1");
      await waitInit(h, 1);
      // A session whose agent has tool access in OTHER (cross-location).
      const created = await createSession(h, 1, sessionChannelURI("wd-term"), {
        provider: "gpuz",
        workingDirectories: [directoryUri(OTHER)],
      });
      expect(created.error).toBeUndefined();
      // VS Code client-claims its pty terminals and opens them in the
      // session's folder: a cwd inside OTHER must pass the clamp
      // (previously it clamped to the location directory).
      const res = await createPtyTerminal(h, "agenthost-terminal://t-wd", {
        cwd: `${OTHER}/sub`,
      }, 950);
      expect(res.error).toBeUndefined();
      const state = await terminalSnapshotState(h, "agenthost-terminal://t-wd", 951);
      expect(state.cwd).toBe(directoryUri(`${OTHER}/sub`));
      // A cwd outside every working root still clamps to the location
      // directory.
      const out = await createPtyTerminal(h, "agenthost-terminal://t-wd-out", {
        cwd: "/etc/ssh",
      }, 952);
      expect(out.error).toBeUndefined();
      const outState = await terminalSnapshotState(h, "agenthost-terminal://t-wd-out", 953);
      expect(outState.cwd).toBe(`file://${DIR}/`);
      h.stop();
    });

    it("rejects duplicate channels with AHP AlreadyExists (-32010)", async () => {
      const h = makeHarness();
      h.init(1, "c1");
      await waitInit(h, 1);
      const first = await createPtyTerminal(h, "agenthost-terminal://t-dup", {}, 950);
      expect(first.error).toBeUndefined();
      const dup = await createPtyTerminal(h, "agenthost-terminal://t-dup", {}, 951);
      expect(dup.error?.code).toBe(-32010);
      expect(h.ptys).toHaveLength(1);
      h.stop();
    });

    it("refuses host-namespace channel URIs (-32600)", async () => {
      const h = makeHarness();
      h.init(1, "c1");
      await waitInit(h, 1);
      for (const [i, channel] of ["ahp-terminal:/x", "ahp-root://", "ahp-session:/x"].entries()) {
        const res = await createPtyTerminal(h, channel, {}, 955 + i);
        expect(res.error?.code, channel).toBe(-32600);
      }
      expect(h.ptys).toHaveLength(0);
      h.stop();
    });

    it("rejects malformed params (-32602): missing channel, missing claim, foreign client claim", async () => {
      const h = makeHarness();
      h.init(1, "c1");
      await waitInit(h, 1);
      // Missing channel.
      h.send(1, "createTerminal", { claim: { kind: "client", clientId: "c1" } }, 960);
      await waitFor(() => h.frames.some((f) => f.message.id === 960), "response");
      expect(h.frames.find((f) => f.message.id === 960)!.message.error.code).toBe(-32602);
      // Missing claim.
      h.send(1, "createTerminal", { channel: "agenthost-terminal://t-m1" }, 961);
      await waitFor(() => h.frames.some((f) => f.message.id === 961), "response");
      expect(h.frames.find((f) => f.message.id === 961)!.message.error.code).toBe(-32602);
      // A client claim naming a different client is a foreign identity, not a credential.
      h.send(
        1,
        "createTerminal",
        { channel: "agenthost-terminal://t-m2", claim: { kind: "client", clientId: "other" } },
        962,
      );
      await waitFor(() => h.frames.some((f) => f.message.id === 962), "response");
      expect(h.frames.find((f) => f.message.id === 962)!.message.error.code).toBe(-32602);
      expect(h.ptys).toHaveLength(0);
      h.stop();
    });

    it("answers -32601 when the terminals capability is off", async () => {
      const h = makeHarness({ terminals: false });
      h.init(1, "c1");
      await waitInit(h, 1);
      const res = await createPtyTerminal(h, "agenthost-terminal://t-off", {}, 970);
      expect(res.error?.code).toBe(-32601);
      h.send(1, "disposeTerminal", { channel: "agenthost-terminal://t-off" }, 971);
      await waitFor(() => h.frames.some((f) => f.message.id === 971), "disposeTerminal response");
      expect(h.frames.find((f) => f.message.id === 971)!.message.error.code).toBe(-32601);
      h.stop();
    });

    it("answers -32601 when the runtime cannot spawn ptys", async () => {
      const h = makeHarness({ spawnPty: null });
      h.init(1, "c1");
      await waitInit(h, 1);
      const res = await createPtyTerminal(h, "agenthost-terminal://t-nosetup", {}, 972);
      expect(res.error?.code).toBe(-32601);
      expect(h.ptys).toHaveLength(0);
      h.stop();
    });

    it("answers -32603 when the spawn throws, and the host survives", async () => {
      const h = makeHarness({
        spawnPty: () => {
          throw new Error("spawn boom");
        },
      });
      h.init(1, "c1");
      await waitInit(h, 1);
      const res = await createPtyTerminal(h, "agenthost-terminal://t-throw", {}, 973);
      expect(res.error?.code).toBe(-32603);
      expect(res.error?.message).toMatch(/spawn boom/);
      expect(h.ptys).toHaveLength(0);
      // R2: the host is still serving (a subscribe on a live channel works).
      const rootSub = await subscribe(h, 1, ROOT_CHANNEL, 974);
      expect(rootSub.error).toBeUndefined();
      h.stop();
    });

    it("streams pty output as terminal/data and trims the stored content to the rolling budget", async () => {
      const h = makeHarness();
      h.init(1, "c1");
      await waitInit(h, 1);
      const uri = "agenthost-terminal://t-stream";
      await createPtyTerminal(h, uri, {}, 975);
      await subscribe(h, 1, uri, 974); // a live subscriber for the data stream
      h.ptys[0]!.emit("A".repeat(120_000));
      const data = await waitForAction(h, uri, "terminal/data");
      expect(data.action.data).toHaveLength(120_000);
      expect(data.rejectionReason).toBeUndefined();
      // The stored snapshot is trimmed to the 80k target (single part).
      const state = await terminalSnapshotState(h, uri, 976);
      expect(state.content).toHaveLength(1);
      expect(state.content[0]).toEqual({ type: "unclassified", value: expect.stringMatching(/^A{80000}$/) });
      // A small append lands in the surviving tail without re-trimming.
      h.ptys[0]!.emit("bc");
      await waitForAction(h, uri, "terminal/data", (a: any) => a.action.data === "bc");
      const state2 = await terminalSnapshotState(h, uri, 977);
      expect(state2.content[0].value).toHaveLength(80_002);
      h.stop();
    });

    it("forwards terminal/input to the process and rejects invalid data", async () => {
      const h = makeHarness();
      h.init(1, "c1");
      await waitInit(h, 1);
      const uri = "agenthost-terminal://t-input";
      await createPtyTerminal(h, uri, {}, 980);
      await subscribe(h, 1, uri, 981);
      dispatch(h, 1, 1, { type: "terminal/input", data: "echo hi\r" }, uri);
      const accepted = await waitForAction(h, uri, "terminal/input");
      expect(accepted.rejectionReason).toBeUndefined();
      expect(h.ptys[0]!.written).toEqual(["echo hi\r"]);
      // Invalid data (not a string) is rejected and never reaches the pty.
      dispatch(h, 1, 2, { type: "terminal/input", data: 42 }, uri);
      const rejected = await waitForAction(h, uri, "terminal/input", (a: any) => a.rejectionReason !== undefined);
      expect(rejected.rejectionReason).toMatch(/data must be a string/);
      expect(h.ptys[0]!.written).toEqual(["echo hi\r"]);
      h.stop();
    });

    it("forwards terminal/resized to the process and the state; rejects non-positive sizes", async () => {
      const h = makeHarness();
      h.init(1, "c1");
      await waitInit(h, 1);
      const uri = "agenthost-terminal://t-resize";
      await createPtyTerminal(h, uri, {}, 985);
      await subscribe(h, 1, uri, 984);
      dispatch(h, 1, 1, { type: "terminal/resized", cols: 100, rows: 50 }, uri);
      const accepted = await waitForAction(h, uri, "terminal/resized");
      expect(accepted.rejectionReason).toBeUndefined();
      expect(h.ptys[0]!.resizes[1]).toEqual({ cols: 100, rows: 50 });
      const state = await terminalSnapshotState(h, uri, 986);
      expect(state.cols).toBe(100);
      expect(state.rows).toBe(50);
      dispatch(h, 1, 2, { type: "terminal/resized", cols: 0, rows: 24 }, uri);
      const rejected = await waitForAction(h, uri, "terminal/resized", (a: any) => a.rejectionReason !== undefined);
      expect(rejected.rejectionReason).toMatch(/positive integers/);
      h.stop();
    });

    it("terminal/claimed is holder-only, a session claim is sticky, and the catalog tracks the claim", async () => {
      const h = makeHarness();
      h.init(1, "c1");
      await waitInit(h, 1);
      h.init(2, "c2");
      await waitInit(h, 2);
      const uri = "agenthost-terminal://t-claim";
      await createPtyTerminal(h, uri, {}, 990);
      await subscribe(h, 1, uri, 989);
      // The non-holder client cannot re-claim.
      dispatch(h, 2, 1, { type: "terminal/claimed", claim: { kind: "client", clientId: "c2" } }, uri);
      const rejected = await waitForAction(h, uri, "terminal/claimed");
      expect(rejected.rejectionReason).toMatch(/only the client currently holding/);
      // The holder transfers the claim to a session scope.
      dispatch(h, 1, 2, {
        type: "terminal/claimed",
        claim: { kind: "session", session: "ahp-session:/s1", chat: "ahp-chat:/s1" },
      }, uri);
      const accepted = await waitForAction(h, uri, "terminal/claimed", (a: any) => a.rejectionReason === undefined);
      expect(accepted.action.claim.kind).toBe("session");
      // Catalog row claim updated.
      await waitFor(() => lastCatalog(h)[0]!.claim.kind === "session", "catalog claim refresh");
      expect(lastCatalog(h)[0]!.claim).toEqual({ kind: "session", session: "ahp-session:/s1", chat: "ahp-chat:/s1" });
      // The session claim is sticky: a later client claim is rejected.
      dispatch(h, 1, 3, { type: "terminal/claimed", claim: { kind: "client", clientId: "c1" } }, uri);
      const sticky = await waitForAction(
        h,
        uri,
        "terminal/claimed",
        (a: any) => a.rejectionReason !== undefined && a.origin?.clientSeq === 3,
      );
      expect(sticky.rejectionReason).toMatch(/only the client currently holding/);
      h.stop();
    });

    it("terminal/titleChanged updates the state and catalog; an empty title is rejected", async () => {
      const h = makeHarness();
      h.init(1, "c1");
      await waitInit(h, 1);
      const uri = "agenthost-terminal://t-title";
      await createPtyTerminal(h, uri, {}, 995);
      await subscribe(h, 1, uri, 994);
      dispatch(h, 1, 1, { type: "terminal/titleChanged", title: "renamed shell" }, uri);
      const accepted = await waitForAction(h, uri, "terminal/titleChanged");
      expect(accepted.rejectionReason).toBeUndefined();
      await waitFor(() => lastCatalog(h)[0]!.title === "renamed shell", "catalog title refresh");
      const state = await terminalSnapshotState(h, uri, 996);
      expect(state.title).toBe("renamed shell");
      dispatch(h, 1, 2, { type: "terminal/titleChanged", title: "" }, uri);
      const rejected = await waitForAction(h, uri, "terminal/titleChanged", (a: any) => a.rejectionReason !== undefined);
      expect(rejected.rejectionReason).toMatch(/non-empty string/);
      h.stop();
    });

    it("terminal/cleared empties the content, and is allowed after exit", async () => {
      const h = makeHarness();
      h.init(1, "c1");
      await waitInit(h, 1);
      const uri = "agenthost-terminal://t-clear";
      await createPtyTerminal(h, uri, {}, 997);
      await subscribe(h, 1, uri, 993);
      h.ptys[0]!.emit("some output");
      await waitForAction(h, uri, "terminal/data");
      dispatch(h, 1, 1, { type: "terminal/cleared" }, uri);
      const cleared = await waitForAction(h, uri, "terminal/cleared");
      expect(cleared.rejectionReason).toBeUndefined();
      let state = await terminalSnapshotState(h, uri, 998);
      expect(state.content).toEqual([]);
      // After exit the state still exists — clear is still accepted.
      h.ptys[0]!.exit(0);
      await waitForAction(h, uri, "terminal/exited");
      h.ptys[0]!.emit("more output after exit");
      await waitForAction(h, uri, "terminal/data", (a: any) => a.action.data === "more output after exit");
      dispatch(h, 1, 2, { type: "terminal/cleared" }, uri);
      await waitForAction(h, uri, "terminal/cleared", (a: any) => a.origin?.clientSeq === 2);
      state = await terminalSnapshotState(h, uri, 999);
      expect(state.content).toEqual([]);
      h.stop();
    });

    it("a self-exit publishes terminal/exited with the code; input/resize are rejected; the row stays listed", async () => {
      const h = makeHarness();
      h.init(1, "c1");
      await waitInit(h, 1);
      const uri = "agenthost-terminal://t-exit";
      await createPtyTerminal(h, uri, {}, 1000);
      await subscribe(h, 1, uri, 1001);
      h.ptys[0]!.exit(3);
      const exited = await waitForAction(h, uri, "terminal/exited");
      expect(exited.action.exitCode).toBe(3);
      expect(exited.rejectionReason).toBeUndefined();
      // The row stays listed with the final lifecycle.
      await waitFor(
        () => lastCatalog(h).some((r: any) => r.resource === uri && r.lifecycle.status === "exited"),
        "exited row in catalog",
      );
      const row = lastCatalog(h).find((r: any) => r.resource === uri)!;
      expect(row.lifecycle).toEqual({ status: "exited", exitCode: 3 });
      // Input and resize on the dead pty are rejected (no process to drive).
      dispatch(h, 1, 1, { type: "terminal/input", data: "ls\r" }, uri);
      const input = await waitForAction(h, uri, "terminal/input");
      expect(input.rejectionReason).toMatch(/exited/);
      dispatch(h, 1, 2, { type: "terminal/resized", cols: 80, rows: 24 }, uri);
      const resized = await waitForAction(h, uri, "terminal/resized");
      expect(resized.rejectionReason).toMatch(/exited/);
      h.stop();
    });

    it("disposeTerminal kills the process, drops the row, is idempotent, and severs the channel", async () => {
      const h = makeHarness();
      h.init(1, "c1");
      await waitInit(h, 1);
      const uri = "agenthost-terminal://t-dispose";
      await createPtyTerminal(h, uri, {}, 1005);
      await subscribe(h, 1, uri, 1002);
      h.ptys[0]!.emit("before");
      await waitForAction(h, uri, "terminal/data");

      h.send(1, "disposeTerminal", { channel: uri }, 1006);
      await waitFor(() => h.frames.some((f) => f.message.id === 1006), "disposeTerminal response");
      const res = h.frames.find((f) => f.message.id === 1006)!.message;
      expect(res.error).toBeUndefined();
      expect(res.result).toBeNull();
      expect(h.ptys[0]!.killed).toBe(true);
      // A final terminal/exited was published for the running process.
      const exited = await waitForAction(h, uri, "terminal/exited");
      expect(exited.action.exitCode).toBeUndefined();
      // The row dropped from the catalog.
      await waitFor(() => lastCatalog(h).length === 0, "catalog drop");

      // Idempotent: an unknown channel answers success null (VS Code's
      // shutdown path disposes terminals that may already be gone).
      h.send(1, "disposeTerminal", { channel: uri }, 1007);
      await waitFor(() => h.frames.some((f) => f.message.id === 1007), "second dispose");
      const res2 = h.frames.find((f) => f.message.id === 1007)!.message;
      expect(res2.error).toBeUndefined();
      expect(res2.result).toBeNull();

      // The channel is gone: subscribe fails with an unknown-channel error.
      const sub = await subscribe(h, 1, uri, 1008);
      expect(sub.error?.code).toBe(-32602);
      // Post-dispose pty callbacks are no-ops (no new data action — the
      // record lookup misses synchronously, so no delay is needed).
      h.ptys[0]!.emit("after dispose");
      expect(h.actionsOn(uri).some((a) => a.action.data === "after dispose")).toBe(false);
      // Dispatching to the disposed URI is an unknown channel.
      dispatch(h, 1, 1, { type: "terminal/input", data: "x" }, uri);
      const dispatchReject = await waitForAction(h, uri, "terminal/input");
      expect(dispatchReject.rejectionReason).toMatch(/unknown channel/);
      h.stop();
    });

    it("refuses to dispose a synthetic (session-owned) terminal (-32009)", async () => {
      const h = makeHarness();
      h.init(1, "c1");
      await waitInit(h, 1);
      const { terminalURI } = await openShellTerminal(h);
      h.send(1, "disposeTerminal", { channel: terminalURI }, 1010);
      await waitFor(() => h.frames.some((f) => f.message.id === 1010), "disposeTerminal response");
      const res = h.frames.find((f) => f.message.id === 1010)!.message;
      expect(res.error?.code).toBe(-32009);
      // The synthetic channel is still alive and subscribable.
      const sub = await subscribe(h, 1, terminalURI, 1011);
      expect(sub.error).toBeUndefined();
      h.stop();
    });

    it("stopTerminals kills every live pty and drops the rows", async () => {
      const h = makeHarness();
      h.init(1, "c1");
      await waitInit(h, 1);
      const uri1 = "agenthost-terminal://t-stop-1";
      const uri2 = "agenthost-terminal://t-stop-2";
      await createPtyTerminal(h, uri1, {}, 1015);
      await createPtyTerminal(h, uri2, {}, 1016);
      await subscribe(h, 1, uri1, 1013);
      await subscribe(h, 1, uri2, 1014);
      await waitFor(() => lastCatalog(h).length === 2, "two catalog rows");
      // One already exited on its own (the final-exited path is skipped).
      h.ptys[0]!.exit(0);
      await waitForAction(h, uri1, "terminal/exited");

      h.host.stopTerminals();
      expect(h.ptys[0]!.killed).toBe(true);
      expect(h.ptys[1]!.killed).toBe(true);
      const finalExited = await waitForAction(h, uri2, "terminal/exited");
      expect(finalExited.action.exitCode).toBeUndefined();
      await waitFor(() => lastCatalog(h).length === 0, "catalog empty");
      h.stop();
    });
  });

  it("rejects subscribing to a terminal that does not exist with -32008", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const res = await subscribe(h, 1, "ahp-terminal:/nope", 902);
    expect(res.error?.code).toBe(-32008);
    h.stop();
  });

  it("session removal exits running terminals and drops the channels", async () => {
    const h = makeHarness();
    h.init(1, "c1");
    await waitInit(h, 1);
    const { sessionURI, terminalURI } = await openShellTerminal(h);
    await subscribe(h, 1, terminalURI, 903); // a live subscriber
    // The session is deleted (TUI) while the command is still running.
    h.facade.push({ type: "session.deleted", sessionID: SES });
    await waitFor(() => h.notification("root/sessionRemoved", 1) !== undefined, "root/sessionRemoved");
    const exited = await waitForAction(h, terminalURI, "terminal/exited");
    expect(exited.action.exitCode).toBeUndefined(); // unknown — the command died
    await waitFor(() => lastCatalog(h).length === 0, "catalog drop on removal");
    const sub = await subscribe(h, 1, terminalURI, 904);
    expect(sub.error?.code).toBe(-32008);
    // The session channel is gone too.
    const sessSub = await subscribe(h, 1, sessionURI, 905);
    expect(sessSub.error?.code).toBe(-32001);
    h.stop();
  });

  it("with the capability off: shell calls open no terminals and publish no catalog actions", async () => {
    const h = makeHarness({ terminals: false });
    h.init(1, "c1");
    await waitInit(h, 1);
    const chatURI = chatChannelURI(SES);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    await subscribe(h, 1, chatURI, 910);
    startTurn(h, chatURI, "tOff", 1, "run it");
    await waitFor(() => h.facade.promptCalls.length === 1, "prompt");
    h.facade.push({ type: "tool.input.started", sessionID: SES, assistantMessageID: "msg_1", id: TOOL, name: "shell" });
    h.facade.push({ type: "tool.input.ended", sessionID: SES, assistantMessageID: "msg_1", id: TOOL, text: JSON.stringify({ command: "echo hi" }) });
    h.facade.push({ type: "tool.success", sessionID: SES, id: TOOL, content: [{ type: "text", text: "hi\n" }] });
    h.facade.push({ type: "execution.succeeded", sessionID: SES });
    await waitForAction(h, chatURI, "chat/turnComplete");
    expect(h.actionsOn(ROOT_CHANNEL).filter((a) => a.action.type === "root/terminalsChanged")).toHaveLength(0);
    const rootSub = await subscribe(h, 1, ROOT_CHANNEL, 911);
    expect(rootSub.result.snapshot.state.terminals).toBeUndefined();
    h.stop();
  });
});
