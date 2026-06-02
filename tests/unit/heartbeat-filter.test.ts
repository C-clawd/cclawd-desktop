import { describe, expect, it } from 'vitest';
import {
  filterHeartbeatTurns,
  isHeartbeatAckAssistantMessage,
  isHeartbeatInjectedUserMessage,
  shouldIgnoreBackgroundMainSessionRun,
} from '@/stores/chat/heartbeat-filter';
import type { RawMessage } from '@/stores/chat/types';

describe('isHeartbeatInjectedUserMessage', () => {
  it('detects the default heartbeat prompt', () => {
    expect(isHeartbeatInjectedUserMessage(
      'Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. If nothing needs attention, reply HEARTBEAT_OK.',
    )).toBe(true);
  });

  it('detects exec completion wake prompts with system lines', () => {
    expect(isHeartbeatInjectedUserMessage(
      [
        'System: [2026-06-02 11:01:36 GMT+8] Exec completed (delta-cr, code 1)',
        'An async command you ran earlier has completed. The result is shown in the system messages above.',
        'Current time: Tuesday, June 2nd, 2026 — 11:02 (Asia/Shanghai)',
      ].join('\n'),
    )).toBe(true);
  });

  it('does not treat normal user messages as heartbeat injections', () => {
    expect(isHeartbeatInjectedUserMessage('请帮我总结今天的任务')).toBe(false);
    expect(isHeartbeatInjectedUserMessage('System: user pasted this manually')).toBe(false);
  });
});

describe('isHeartbeatAckAssistantMessage', () => {
  it('treats HEARTBEAT_OK-only replies as internal acks', () => {
    expect(isHeartbeatAckAssistantMessage('HEARTBEAT_OK')).toBe(true);
    expect(isHeartbeatAckAssistantMessage('HEARTBEAT_OK.')).toBe(true);
  });

  it('keeps substantive assistant replies', () => {
    expect(isHeartbeatAckAssistantMessage('Your cron job finished with errors.')).toBe(false);
  });
});

describe('filterHeartbeatTurns', () => {
  it('removes heartbeat user turns and their follow-up acks from main sessions', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
      {
        role: 'user',
        content: 'System: [2026-06-02 11:01:36 GMT+8] Exec completed\nRead HEARTBEAT.md if it exists...',
      },
      { role: 'assistant', content: 'HEARTBEAT_OK' },
      { role: 'user', content: 'Next question' },
    ];

    expect(filterHeartbeatTurns(messages, 'agent:main:main')).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: 'Next question' },
    ]);
  });

  it('leaves non-main sessions untouched', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'Read HEARTBEAT.md if it exists...' },
      { role: 'assistant', content: 'HEARTBEAT_OK' },
    ];

    expect(filterHeartbeatTurns(messages, 'agent:main:session-1')).toEqual(messages);
  });
});

describe('shouldIgnoreBackgroundMainSessionRun', () => {
  it('ignores background main-session runs when the user did not send a message', () => {
    expect(shouldIgnoreBackgroundMainSessionRun({
      sessionKey: 'agent:main:main',
      currentSessionKey: 'agent:main:main',
      lastUserMessageAt: null,
      sending: false,
    })).toBe(true);
  });

  it('allows user-initiated runs on the main session', () => {
    expect(shouldIgnoreBackgroundMainSessionRun({
      sessionKey: 'agent:main:main',
      currentSessionKey: 'agent:main:main',
      lastUserMessageAt: Date.now(),
      sending: true,
    })).toBe(false);
  });
});
