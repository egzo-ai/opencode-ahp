/**
 * Turn lifecycle section (design §8): host-minted turn ids, turn start/claim, and the turn-terminal handoff (steering/queue, changeset + terminal catalog refresh).
 */

import { HostTerminals } from "./host-terminals.js";
import { ActionType, PendingMessageKind, Message } from "@microsoft/agent-host-protocol";
import { ChatRuntime } from "./host-types.js";

export class HostTurns extends HostTerminals {
  // ── turn helpers ───────────────────────────────────────────────────────
  protected mintTurnId(): string {
    this.turnCounter += 1;
    return `turn_${Date.now().toString(36)}_${this.turnCounter.toString(36)}`;
  }

  protected turnDuration(chat: ChatRuntime): number {
    return Math.max(0, Date.now() - (chat.turnStartedAt ?? Date.now()));
  }

  /**
   * Claim a turn (write-ahead) and publish `chat/turnStarted`. `inboxID`
   * is the opencode inbox item the turn answers, when known.
   */
  protected startTurn(chat: ChatRuntime, message: Message, queuedMessageId?: string, inboxID?: string): void {
    const turnId = this.mintTurnId();
    chat.currentTurnId = turnId;
    chat.turnStartedAt = Date.now();
    chat.turnInboxID = inboxID ?? null;
    this.publish({
      channel: chat.uri,
      action: {
        type: ActionType.ChatTurnStarted,
        turnId,
        startedAt: new Date().toISOString(),
        message,
        ...(queuedMessageId !== undefined ? { queuedMessageId } : {}),
      },
    });
  }

  /**
   * After a turn terminal: clear the steering message opencode consumed
   * during the turn. A queued message does not start here: opencode
   * delivers it inside the same execution, after the running turn's
   * answer, and the queued turn starts at that `session.inbox.delivered`
   * (handleEvent). After an interrupt or a failure opencode keeps it in
   * its inbox, and so it stays queued: AHP starts a queued message after
   * a turn that finishes naturally.
   *
   * Then refresh the session's changesets — the turn's captured
   * "after" content is read from disk here, and the uncommitted/session/
   * turn changesets recompute (async: awaits the facade).
   */
  protected async finishTurn(chat: ChatRuntime): Promise<void> {
    const endedTurnId = chat.currentTurnId;
    chat.currentTurnId = null;
    chat.turnStartedAt = null;
    chat.turnInboxID = null;
    const state = chat.chatStore.state;
    if (state.steeringMessage !== undefined) {
      this.publish({
        channel: chat.uri,
        action: {
          type: ActionType.ChatPendingMessageRemoved,
          kind: PendingMessageKind.Steering,
          id: state.steeringMessage.id,
        },
      });
    }
    // The ended turn's command terminals leave the
    // root catalog now (retention — their state stays subscribable until
    // the chat/record is removed).
    if (this.opts.terminals && endedTurnId !== null && this.terminals.size > 0) {
      this.refreshTerminals();
    }
    if (this.opts.changesets && endedTurnId !== null) {
      await this.refreshTurnChangesets(this.byChannel.get(chat.uri)!, chat, endedTurnId);
    }
  }
}
