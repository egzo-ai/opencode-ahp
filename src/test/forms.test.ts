/**
 * opencode forms ↔ AHP chat input requests (design §8.2): the mapping both
 * ways, the bridge's reading of `form.*` events, and the host's round
 * trips (a form asked during a turn, answered or dismissed by a client, or
 * closed in opencode).
 */

import { describe, expect, it } from "vitest";
import { mapV2Event, type FacadeFormField } from "../bridge.js";
import { sessionChannelURI, chatChannelURI } from "../channels.js";
import { formAnswer, formRequest } from "../forms.js";
import { makeHarness, waitInit, createSession, subscribe, waitFor, waitForAction, chatSnapshotState, type Harness } from "./host-fakes.js";

// The web-search consent opencode 2.3 asks when no provider is chosen.
const WEBSEARCH: FacadeFormField[] = [
  {
    key: "choice",
    type: "string",
    description: "Allow OpenCode to search the web for up-to-date information?",
    required: true,
    custom: false,
    options: [
      { value: "allow", label: "Allow search via Exa" },
      { value: "choose", label: "Choose another provider" },
      { value: "disable", label: "Disable web search" },
    ],
  },
];

describe("form mapping", () => {
  it("asks each visible field as a question of its kind", () => {
    const fields: FacadeFormField[] = [
      ...WEBSEARCH,
      { key: "why", type: "string", title: "Why", maxLength: 200, default: "because" },
      { key: "n", type: "integer", minimum: 1, maximum: 9 },
      { key: "ok", type: "boolean", default: true },
      { key: "tags", type: "multiselect", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], custom: true, default: ["b"] },
      { key: "secret", type: "string", hidden: true },
      { key: "page", type: "external", url: "https://example.com/auth" },
    ];
    const req = formRequest("form_1", "Web Search", fields);
    expect(req.id).toBe("form_1");
    expect(req.message).toBe("Web Search");
    expect(req.url).toBe("https://example.com/auth");
    expect(req.questions).toEqual([
      {
        id: "choice",
        message: "Allow OpenCode to search the web for up-to-date information?",
        required: true,
        kind: "single-select",
        options: [
          { id: "allow", label: "Allow search via Exa" },
          { id: "choose", label: "Choose another provider" },
          { id: "disable", label: "Disable web search" },
        ],
      },
      { id: "why", title: "Why", message: "Why", kind: "text", max: 200, defaultValue: "because" },
      { id: "n", message: "n", kind: "integer", min: 1, max: 9 },
      { id: "ok", message: "ok", kind: "boolean", defaultValue: true },
      {
        id: "tags",
        message: "tags",
        kind: "multi-select",
        options: [{ id: "a", label: "A" }, { id: "b", label: "B", recommended: true }],
        allowFreeformInput: true,
      },
    ]);
  });

  it("answers in each field's own value type, leaving out what was skipped", () => {
    const fields: FacadeFormField[] = [
      ...WEBSEARCH,
      { key: "why", type: "string" },
      { key: "n", type: "number" },
      { key: "ok", type: "boolean" },
      { key: "tags", type: "multiselect", options: [] },
      { key: "other", type: "string", options: [{ value: "x", label: "X" }], custom: true },
      { key: "skipped", type: "string" },
    ];
    expect(
      formAnswer(fields, {
        choice: { state: "submitted", value: { kind: "selected", value: "allow" } },
        why: { state: "submitted", value: { kind: "text", value: "to know" } },
        n: { state: "draft", value: { kind: "number", value: 2.5 } },
        ok: { state: "submitted", value: { kind: "boolean", value: false } },
        tags: { state: "submitted", value: { kind: "selected-many", value: ["a"], freeformValues: ["z"] } },
        other: { state: "submitted", value: { kind: "selected", value: "", freeformValues: ["typed"] } },
        skipped: { state: "skipped" },
      } as never),
    ).toEqual({ choice: "allow", why: "to know", n: 2.5, ok: false, tags: ["a", "z"], other: "typed" });
  });
});

describe("form events", () => {
  it("reads form.created, whose session is inside the form", () => {
    const ev = mapV2Event({
      id: "evt_1",
      created: 1,
      type: "form.created",
      data: {
        form: {
          id: "frm_1",
          sessionID: "ses_f",
          title: "Web Search",
          metadata: { kind: "websearch.provider" },
          fields: [{ ...WEBSEARCH[0], options: WEBSEARCH[0]!.options }, { key: "bad" }],
        },
      },
    });
    expect(ev).toEqual({
      type: "form.created",
      sessionID: "ses_f",
      formID: "frm_1",
      title: "Web Search",
      metadata: { kind: "websearch.provider" },
      fields: WEBSEARCH,
    });
  });

  it("reads form.replied and form.cancelled", () => {
    expect(mapV2Event({ id: "e", created: 1, type: "form.replied", data: { id: "frm_1", sessionID: "ses_f", answer: { choice: "allow" } } })).toEqual({
      type: "form.replied",
      sessionID: "ses_f",
      formID: "frm_1",
    });
    expect(mapV2Event({ id: "e", created: 1, type: "form.cancelled", data: { id: "frm_1", sessionID: "ses_f" } })).toEqual({
      type: "form.cancelled",
      sessionID: "ses_f",
      formID: "frm_1",
    });
  });
});

describe("forms as input requests", () => {
  const SES = "ses_forms";

  async function formDuringATurn(h: Harness) {
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
    const chatURI = chatChannelURI(SES);
    await subscribe(h, 1, sessionChannelURI(SES), 110);
    await subscribe(h, 1, chatURI, 111);
    h.send(1, "dispatchAction", {
      channel: chatURI,
      clientSeq: 1,
      action: { type: "chat/turnStarted", turnId: "tF", startedAt: new Date().toISOString(), message: { text: "search the web", origin: { kind: "user" } } },
    });
    await waitFor(() => h.facade.promptCalls.length === 1, "prompt");
    h.facade.push({ type: "execution.started", sessionID: SES });
    h.facade.push({ type: "form.created", sessionID: SES, formID: "frm_1", title: "Web Search", fields: WEBSEARCH });
    const requested = await waitForAction(h, chatURI, "chat/inputRequested");
    const needed = await waitForAction(h, sessionChannelURI(SES), "session/inputNeededSet");
    return { chatURI, requested, needed };
  }

  it("asks a form opencode opens during a turn as an input request of that turn, and the session needs input", async () => {
    const h = makeHarness();
    const { chatURI, requested, needed } = await formDuringATurn(h);
    expect(requested.action.request).toEqual(formRequest("frm_1", "Web Search", WEBSEARCH));
    expect(needed.action.request).toMatchObject({ id: "frm_1", kind: "chatInput", chat: chatURI });
    const chat = await chatSnapshotState(h, 1, chatURI, 120);
    const part = chat.activeTurn!.responseParts.find((p) => p.kind === "inputRequest");
    expect(part).toMatchObject({ kind: "inputRequest", request: { id: "frm_1" } });
    h.stop();
  });

  it("sends a client's answer to opencode's form, and closes the request", async () => {
    const h = makeHarness();
    const { chatURI } = await formDuringATurn(h);
    h.send(1, "dispatchAction", {
      channel: chatURI,
      clientSeq: 2,
      action: {
        type: "chat/inputCompleted",
        requestId: "frm_1",
        response: "accept",
        answers: { choice: { state: "submitted", value: { kind: "selected", value: "allow" } } },
      },
    });
    await waitFor(() => h.facade.formReplies.length === 1, "the form reply");
    expect(h.facade.formReplies[0]).toEqual({ sessionID: SES, formID: "frm_1", answer: { choice: "allow" } });
    const done = await waitForAction(h, chatURI, "chat/inputCompleted");
    expect(done.rejectionReason).toBeUndefined();
    await waitForAction(h, sessionChannelURI(SES), "session/inputNeededRemoved", (a) => a.action.id === "frm_1");
    // opencode's own form.replied follows: nothing more to close
    h.facade.push({ type: "form.replied", sessionID: SES, formID: "frm_1" });
    await new Promise((r) => setTimeout(r, 30));
    expect(h.actionsOn(chatURI).filter((a) => a.action.type === "chat/inputCompleted")).toHaveLength(1);
    const chat = await chatSnapshotState(h, 1, chatURI, 121);
    expect(chat.activeTurn!.responseParts.find((p) => p.kind === "inputRequest")).toMatchObject({ response: "accept" });
    h.stop();
  });

  it("keeps the client's answers when opencode reports the reply before it returns", async () => {
    const h = makeHarness();
    const { chatURI } = await formDuringATurn(h);
    // opencode publishes form.replied while it handles the reply request
    h.facade.replyForm = async (input) => {
      h.facade.formReplies.push(input);
      h.facade.push({ type: "form.replied", sessionID: SES, formID: input.formID });
      await new Promise((r) => setTimeout(r, 30));
    };
    h.send(1, "dispatchAction", {
      channel: chatURI,
      clientSeq: 2,
      action: { type: "chat/inputCompleted", requestId: "frm_1", response: "accept", answers: { choice: { state: "submitted", value: { kind: "selected", value: "allow" } } } },
    });
    await waitForAction(h, chatURI, "chat/inputCompleted", (a) => a.origin !== undefined);
    await new Promise((r) => setTimeout(r, 30));
    expect(h.actionsOn(chatURI).filter((a) => a.action.type === "chat/inputCompleted")).toHaveLength(1);
    const chat = await chatSnapshotState(h, 1, chatURI, 123);
    const part = chat.activeTurn!.responseParts.find((p) => p.kind === "inputRequest");
    expect(part).toMatchObject({ response: "accept", request: { answers: { choice: { value: { value: "allow" } } } } });
    h.stop();
  });

  it("cancels opencode's form when a client declines", async () => {
    const h = makeHarness();
    const { chatURI } = await formDuringATurn(h);
    h.send(1, "dispatchAction", { channel: chatURI, clientSeq: 2, action: { type: "chat/inputCompleted", requestId: "frm_1", response: "decline" } });
    await waitFor(() => h.facade.formCancels.length === 1, "the form cancel");
    expect(h.facade.formCancels[0]).toEqual({ sessionID: SES, formID: "frm_1" });
    expect(h.facade.formReplies).toHaveLength(0);
    h.stop();
  });

  it("closes the request when opencode closes the form (answered in the TUI, or expired)", async () => {
    const h = makeHarness();
    const { chatURI } = await formDuringATurn(h);
    h.facade.push({ type: "form.cancelled", sessionID: SES, formID: "frm_1" });
    const done = await waitForAction(h, chatURI, "chat/inputCompleted");
    expect(done.action).toMatchObject({ requestId: "frm_1", response: "cancel" });
    await waitForAction(h, sessionChannelURI(SES), "session/inputNeededRemoved", (a) => a.action.id === "frm_1");
    // a late answer finds nothing open
    h.send(1, "dispatchAction", { channel: chatURI, clientSeq: 3, action: { type: "chat/inputCompleted", requestId: "frm_1", response: "accept" } });
    const late = await waitForAction(h, chatURI, "chat/inputCompleted", (a) => a.rejectionReason !== undefined);
    expect(late.rejectionReason).toMatch(/no open input request/);
    expect(h.facade.formReplies).toHaveLength(0);
    h.stop();
  });

  it("keeps the request open when opencode refuses the answer", async () => {
    const h = makeHarness();
    const { chatURI } = await formDuringATurn(h);
    h.facade.replyForm = async () => {
      throw new Error("400 choice is required");
    };
    h.send(1, "dispatchAction", { channel: chatURI, clientSeq: 2, action: { type: "chat/inputCompleted", requestId: "frm_1", response: "accept" } });
    const refused = await waitForAction(h, chatURI, "chat/inputCompleted");
    expect(refused.rejectionReason).toMatch(/choice is required/);
    const chat = await chatSnapshotState(h, 1, chatURI, 122);
    expect(chat.activeTurn!.responseParts.find((p) => p.kind === "inputRequest")).not.toHaveProperty("response");
    h.stop();
  });
});
