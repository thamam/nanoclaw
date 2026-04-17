// Approval flow — posts a prompt on the originating channel and waits for a
// reply from the authorised operator. One-shot listener + 5-minute timeout.

import { replyBus, type ChannelKind, type ReplyEvent } from '../channels/reply-bus.js';

export type ReplySender = (channel: ChannelKind, text: string) => Promise<void>;

export type ApprovalOutcome = 'approved' | 'denied' | 'timed_out';

export interface AwaitReplyOptions {
  channel: ChannelKind;
  userId: string;            // operator ID for this channel (string form)
  timeoutMs: number;
  promptText: string;
  sendPrompt: ReplySender;
}

export interface ApprovalResult {
  outcome: ApprovalOutcome;
  replyText?: string;
}

export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function classifyReply(text: string): ApprovalOutcome | 'other' {
  const t = text.trim().toLowerCase();
  if (t === 'approve') return 'approved';
  if (t === 'deny') return 'denied';
  return 'other';
}

/**
 * Post `promptText` to `channel`, then wait up to `timeoutMs` for a reply
 * from the configured operator (`userId`). Replies from any other user are
 * ignored (listener keeps waiting). Any non-approve/deny text from the
 * operator is ignored (listener keeps waiting) — approval is explicit.
 *
 * Cleans up its listener on resolve.
 */
export async function awaitReply(options: AwaitReplyOptions): Promise<ApprovalResult> {
  await options.sendPrompt(options.channel, options.promptText);

  return new Promise<ApprovalResult>((resolve) => {
    let settled = false;

    const listener = (ev: ReplyEvent) => {
      if (ev.channel !== options.channel) return;
      if (String(ev.userId) !== String(options.userId)) return;
      const outcome = classifyReply(ev.text);
      if (outcome === 'other') return; // keep waiting
      done({ outcome, replyText: ev.text });
    };

    const timer = setTimeout(() => {
      done({ outcome: 'timed_out' });
    }, options.timeoutMs);

    const done = (result: ApprovalResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      replyBus.off('reply', listener);
      resolve(result);
    };

    replyBus.on('reply', listener);
  });
}
