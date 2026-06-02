import { getMessageText } from './helpers';
import type { RawMessage } from './types';

const HEARTBEAT_PROMPT_PREFIX = 'read heartbeat.md';
const HEARTBEAT_OK = 'HEARTBEAT_OK';
const EXEC_EVENT_PROMPT = 'an async command you ran earlier has completed';
const CRON_REMINDER_PROMPT = 'a scheduled reminder has been triggered';
const CRON_EMPTY_PROMPT = 'a scheduled cron event was triggered';

function normalizeForMatch(text: string): string {
  return text.trim().toLowerCase();
}

function isIgnorableNonSystemLine(line: string): boolean {
  const lower = line.toLowerCase();
  if (lower.startsWith('current time:')) return true;
  if (lower.includes('when reading heartbeat.md')) return true;
  if (lower.startsWith(HEARTBEAT_PROMPT_PREFIX)) return true;
  if (lower.includes(EXEC_EVENT_PROMPT)) return true;
  if (lower.includes(CRON_REMINDER_PROMPT) || lower.includes(CRON_EMPTY_PROMPT)) return true;
  if (lower.includes('exec finished') || lower.includes('exec completed')) return true;
  if (lower.includes('handle this reminder internally')) return true;
  if (lower.includes('handle the result internally')) return true;
  if (lower.includes('reply heartbeat_ok')) return true;
  return false;
}

function isAutomationSystemLine(line: string): boolean {
  const lower = line.toLowerCase();
  if (!lower.startsWith('system:')) return false;
  return (
    lower.includes('exec finished')
    || lower.includes('exec completed')
    || lower.includes('cron:')
    || lower.includes('reminder:')
    || lower.includes('auto-disabled')
    || lower.includes('heartbeat poll')
  );
}

/** User turn injected by Gateway heartbeat / cron wake / exec notify. */
export function isHeartbeatInjectedUserMessage(content: unknown): boolean {
  const text = getMessageText(content).trim();
  if (!text) return false;

  const lower = normalizeForMatch(text);
  if (lower.startsWith(HEARTBEAT_PROMPT_PREFIX)) return true;
  if (lower.includes(EXEC_EVENT_PROMPT)) return true;
  if (lower.includes(CRON_REMINDER_PROMPT) || lower.includes(CRON_EMPTY_PROMPT)) return true;
  if (lower.includes('system:') && lower.includes('heartbeat.md')) return true;

  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const hasSystemLine = lines.some((line) => line.toLowerCase().startsWith('system:'));
  if (!hasSystemLine) return false;

  const systemOnly = lines.every((line) => line.toLowerCase().startsWith('system:'));
  if (systemOnly) {
    return lines.some(isAutomationSystemLine);
  }

  return lines.every((line) => {
    const lineLower = line.toLowerCase();
    if (lineLower.startsWith('system:')) return true;
    return isIgnorableNonSystemLine(line);
  });
}

function stripHeartbeatAck(text: string): string {
  let remaining = text.trim();
  if (!remaining) return '';

  const token = HEARTBEAT_OK;
  const tokenLower = token.toLowerCase();

  // Strip leading ack token (optionally prefixed), mirroring gateway heartbeat ack rules.
  const leading = remaining.match(/^[[(\s]*HEARTBEAT_OK[\s.,!?;:)\]]*/i);
  if (leading) {
    remaining = remaining.slice(leading[0].length).trim();
  }

  const trailing = remaining.match(/[\s.,!?;:([[\s]*HEARTBEAT_OK[\s.,!?;:)\]]*$/i);
  if (trailing) {
    remaining = remaining.slice(0, remaining.length - trailing[0].length).trim();
  }

  if (remaining.toLowerCase() === tokenLower) {
    return '';
  }

  return remaining;
}

/** Assistant reply that is only an internal heartbeat acknowledgement. */
export function isHeartbeatAckAssistantMessage(content: unknown): boolean {
  const text = getMessageText(content).trim();
  if (!text) return true;
  return stripHeartbeatAck(text).length === 0;
}

function shouldKeepHeartbeatFollowUp(msg: RawMessage): boolean {
  if (msg.role !== 'assistant') return false;
  const text = getMessageText(msg.content).trim();
  if (!text) return false;
  return !isHeartbeatAckAssistantMessage(msg.content);
}

/** Remove heartbeat/cron/exec wake turns from main-session history shown in Desktop chat. */
export function filterHeartbeatTurns(messages: RawMessage[], sessionKey: string): RawMessage[] {
  if (!sessionKey.endsWith(':main')) return messages;

  const result: RawMessage[] = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index];
    if (message.role === 'user' && isHeartbeatInjectedUserMessage(message.content)) {
      index += 1;
      while (index < messages.length && messages[index].role !== 'user') {
        if (shouldKeepHeartbeatFollowUp(messages[index])) {
          result.push(messages[index]);
        }
        index += 1;
      }
      continue;
    }

    result.push(message);
    index += 1;
  }

  return result;
}

/** Ignore gateway runs on the main session that the user did not start from Desktop chat. */
export function shouldIgnoreBackgroundMainSessionRun(params: {
  sessionKey: string | null;
  currentSessionKey: string;
  lastUserMessageAt: number | null;
  sending: boolean;
}): boolean {
  const { sessionKey, currentSessionKey, lastUserMessageAt, sending } = params;
  if (!sessionKey || sessionKey !== currentSessionKey) return false;
  if (!currentSessionKey.endsWith(':main')) return false;
  if (sending || lastUserMessageAt != null) return false;
  return true;
}
