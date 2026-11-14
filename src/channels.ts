/**
 * AHP channel registry: URI parsing/formatting, per-socket subscription
 * bookkeeping, and the sets of live opencode sessions and live terminal
 * channels. Pure in-memory — no runtime dependencies.
 *
 * Channel kinds: root, session, chat, changeset
 * (`<owner>/changeset/{uncommitted|session|turn/<turnId>}`), and terminal.
 * Sessions may also live on a non-standard `<scheme>:/<suffix>` channel
 * (client legacy addressing — `isSessionChannel`); such URIs classify
 * "unknown" by prefix and are tracked in the registry's live
 * session-channel set instead.
 */

export const ROOT_CHANNEL = "ahp-root://";
const SESSION_PREFIX = "ahp-session:/";
const CHAT_PREFIX = "ahp-chat:/";
const CHANGASET_MARKER = "/changeset/";
const TERMINAL_PREFIX = "ahp-terminal:/";
/**
 * The non-standard session-channel form real clients send: `<scheme>:/
 * <suffix>` — a scheme token, a single slash (empty authority), a
 * non-empty suffix. VS Code's legacy addressing (hosts predating the
 * `vscode.ahpSessionUris` capability) and the AHP Swift reference client
 * both create sessions under `<provider>:/<uuid>`. The spec's
 * client-chosen URI is exemplified, not mandated — the host accepts this
 * form and echoes the channel back verbatim (design §6).
 */
const LEGACY_SESSION_RE = /^([a-z][a-z0-9+.-]*):\/([^/].*)$/i;

export type ChannelKind = "root" | "session" | "chat" | "changeset" | "terminal" | "unknown";

export function channelKind(uri: string): ChannelKind {
  if (uri === ROOT_CHANNEL) return "root";
  // A changeset URI is an owner session/chat URI plus `/changeset/<kind>`.
  // Checked before the owner prefixes so `<sessionURI>/changeset/session`
  // is not misread as a session channel whose suffix contains the marker
  // (createSession rejects such suffixes, so no live session channel can
  // contain the marker).
  if (uri.lastIndexOf(CHANGASET_MARKER) > 0) return "changeset";
  if (uri.startsWith(SESSION_PREFIX) && uri.length > SESSION_PREFIX.length) return "session";
  if (uri.startsWith(CHAT_PREFIX) && uri.length > CHAT_PREFIX.length) return "chat";
  // Synthetic shell-command terminals.
  if (uri.startsWith(TERMINAL_PREFIX) && uri.length > TERMINAL_PREFIX.length) return "terminal";
  return "unknown";
}

/** Channel URI of a session. */
export function sessionChannelURI(sessionID: string): string {
  return SESSION_PREFIX + sessionID;
}

/**
 * Channel URI of a session's default chat. The default chat reuses the
 * session's opencode id as its suffix (the single-chat zero-wire-change
 * mapping); peer chats created via `createChat` carry client-chosen
 * suffixes instead.
 */
export function chatChannelURI(sessionID: string): string {
  return CHAT_PREFIX + sessionID;
}

/**
 * Channel URI of a synthetic shell-command terminal. The suffix is the
 * opencode tool call id —
 * globally unique per tool invocation, so the URI is unambiguous and the
 * terminal correlates 1:1 with the `chat/toolCall*` actions for the same
 * call.
 */
export function terminalChannelURI(toolCallId: string): string {
  return TERMINAL_PREFIX + toolCallId;
}

/**
 * Whether `uri` is a session channel in a form the host accepts: the
 * standard `ahp-session:/<suffix>`, or the non-standard
 * `<scheme>:/<suffix>` form clients use for legacy addressing
 * (design §6). Chat, root, terminal, and changeset URIs never qualify.
 */
export function isSessionChannel(uri: string): boolean {
  const kind = channelKind(uri);
  if (kind !== "unknown") return kind === "session";
  return LEGACY_SESSION_RE.test(uri);
}

/** The session id behind a session/chat channel URI, or null. */
export function sessionIDOf(uri: string): string | null {
  const kind = channelKind(uri);
  if (kind === "session") return uri.slice(SESSION_PREFIX.length);
  if (kind === "chat") return uri.slice(CHAT_PREFIX.length);
  // The legacy session form (<scheme>:/<suffix>, see isSessionChannel):
  // the suffix is everything after the first ":/".
  if (kind === "unknown") {
    const m = LEGACY_SESSION_RE.exec(uri);
    if (m !== null) return m[2] ?? null;
  }
  return null;
}

/**
 * The three changeset kinds this host advertises:
 *  - `uncommitted`: working tree vs HEAD (owner: the chat channel);
 *  - `session`: session-wide changes, same approximation (owner: the
 *    session channel — the protocol's "session" changeKind);
 *  - `turn`: the files a single turn captured before its edits
 *    (owner: the chat channel; `turnId` is the AHP turn id).
 */
export type ChangesetKind = "uncommitted" | "session" | "turn";

export interface ParsedChangesetChannel {
  /** The owner session/chat channel URI (valid — see `sessionIDOf`). */
  ownerUri: string;
  /** The owner's opencode session id. */
  sessionID: string;
  kind: ChangesetKind;
  /** Present iff `kind === "turn"`. */
  turnId?: string;
}

/**
 * Parse a changeset channel URI of the shape
 * `<owner session|chat URI>/changeset/{uncommitted|session|turn/<turnId>}`,
 * or null when the URI is not one. `lastIndexOf` splits on the LAST marker,
 * and the owner must classify as a session/chat channel — so a URI whose
 * owner itself contains the marker fails (no live session channel ever
 * contains it: createSession rejects such suffixes).
 */
export function parseChangesetChannel(uri: string): ParsedChangesetChannel | null {
  const index = uri.lastIndexOf(CHANGASET_MARKER);
  if (index <= 0) return null;
  const ownerUri = uri.slice(0, index);
  const sessionID = sessionIDOf(ownerUri);
  if (sessionID === null) return null;
  const rest = uri.slice(index + CHANGASET_MARKER.length);
  if (rest === "uncommitted" || rest === "session") {
    return { ownerUri, sessionID, kind: rest };
  }
  if (rest.startsWith("turn/")) {
    const turnId = rest.slice("turn/".length);
    // Non-empty, no slashes: an AHP turn id (host-minted `turn-…`).
    if (turnId.length > 0 && !turnId.includes("/")) return { ownerUri, sessionID, kind: "turn", turnId };
  }
  return null;
}

/**
 * Changeset URI of one chat's uncommitted (working-tree) changes. The
 * owner is the chat channel itself (multi-chat: every chat has its own
 * uncommitted changeset).
 */
export function uncommittedChangesetURI(chatChannel: string): string {
  return `${chatChannel}/changeset/uncommitted`;
}

/** Changeset URI of a session's session-wide changes (owner: the session channel). */
export function sessionChangesetURI(sessionChannel: string): string {
  return `${sessionChannel}/changeset/session`;
}

/** Changeset URI of one turn's captured file changes (owner: the chat channel). */
export function turnChangesetURI(chatChannel: string, turnId: string): string {
  return `${chatChannel}/changeset/turn/${turnId}`;
}

export interface SubscribeOutcome {
  ok: boolean;
  reason?: "unknown-uri" | "no-such-session" | "no-such-terminal";
}

/**
 * Subscription bookkeeping keyed by transport socket id, plus the set of
 * live session ids, the set of live session CHANNEL URIs (the host
 * adds/removes them in step with the session records — needed for
 * non-standard `<scheme>:/<suffix>` session channels, which classify
 * "unknown" by prefix alone), and the set of live terminal channel URIs
 * (synthetic `ahp-terminal:` channels AND client-chosen pty terminal
 * channels from `createTerminal`, whose URIs classify "unknown" by
 * prefix alone).
 */
export class ChannelRegistry {
  private readonly subs = new Map<number, Set<string>>();
  private readonly sessions = new Set<string>();
  private readonly sessionChannels = new Set<string>();
  private readonly terminals = new Set<string>();

  /** Subscribe a socket to a channel; fails for unknown URIs, dead sessions, or gone terminals. */
  subscribe(socketId: number, uri: string): SubscribeOutcome {
    const kind = channelKind(uri);
    if (kind === "unknown") {
      // A non-standard (legacy) session channel or a client-chosen
      // terminal URI (a live pty terminal) classifies "unknown" by
      // prefix; each is subscribable while the host keeps it in its
      // live set (in step with the record maps).
      if (!this.sessionChannels.has(uri) && !this.terminals.has(uri)) {
        return { ok: false, reason: "unknown-uri" };
      }
    } else if (kind !== "root") {
      let id: string | null;
      if (kind === "changeset") {
        const parsed = parseChangesetChannel(uri);
        if (parsed === null) return { ok: false, reason: "unknown-uri" };
        id = parsed.sessionID;
      } else if (kind === "terminal") {
        if (!this.terminals.has(uri)) return { ok: false, reason: "no-such-terminal" };
        id = null;
      } else {
        id = sessionIDOf(uri);
      }
      if (id !== null && !this.sessions.has(id)) return { ok: false, reason: "no-such-session" };
    }
    let set = this.subs.get(socketId);
    if (!set) {
      set = new Set();
      this.subs.set(socketId, set);
    }
    set.add(uri);
    return { ok: true };
  }

  unsubscribe(socketId: number, uri: string): void {
    this.subs.get(socketId)?.delete(uri);
  }

  /** URIs a socket is subscribed to (idempotent re-subscribe keeps one entry). */
  subscriptionsOf(socketId: number): readonly string[] {
    return [...(this.subs.get(socketId) ?? [])];
  }

  /** Socket ids currently subscribed to uri — broadcast targets. */
  socketsSubscribedTo(uri: string): readonly number[] {
    const out: number[] = [];
    for (const [socketId, set] of this.subs) if (set.has(uri)) out.push(socketId);
    return out;
  }

  /** Drop a socket's subscriptions (connection closed). */
  removeSocket(socketId: number): void {
    this.subs.delete(socketId);
  }

  // ── live sessions (session/chat channels) ─────────────────────────────

  addSession(sessionID: string): void {
    this.sessions.add(sessionID);
  }

  removeSession(sessionID: string): void {
    this.sessions.delete(sessionID);
  }

  hasSession(sessionID: string): boolean {
    return this.sessions.has(sessionID);
  }

  // ── live session channel URIs (non-standard forms) ────────────────────

  addSessionChannel(uri: string): void {
    this.sessionChannels.add(uri);
  }

  removeSessionChannel(uri: string): void {
    this.sessionChannels.delete(uri);
  }

  hasSessionChannel(uri: string): boolean {
    return this.sessionChannels.has(uri);
  }

  // ── live terminals (synthetic channels + client-chosen pty channels) ──

  addTerminal(uri: string): void {
    this.terminals.add(uri);
  }

  removeTerminal(uri: string): void {
    this.terminals.delete(uri);
  }

  hasTerminal(uri: string): boolean {
    return this.terminals.has(uri);
  }
}
