/** Stable fingerprint for gateway chat/agent event payloads (dedupe exact replays). */
export function stableGatewayEventFingerprint(value: unknown): string {
  let hash = 2166136261;
  let length = 0;

  const add = (part: string): void => {
    length += part.length;
    for (let i = 0; i < part.length; i += 1) {
      hash ^= part.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
  };

  const visit = (entry: unknown): void => {
    if (entry === undefined) {
      add('u:');
      return;
    }
    if (entry === null || typeof entry !== 'object') {
      add(`${typeof entry}:${JSON.stringify(entry)};`);
      return;
    }
    if (Array.isArray(entry)) {
      add('[');
      for (const item of entry) visit(item);
      add(']');
      return;
    }

    add('{');
    for (const [key, child] of Object.entries(entry as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))) {
      add(`${JSON.stringify(key)}:`);
      visit(child);
    }
    add('}');
  };

  visit(value);
  return `${hash.toString(36)}:${length.toString(36)}`;
}

export function buildStreamingDeltaDedupeKey(event: Record<string, unknown>): string {
  const runId = event.runId != null ? String(event.runId) : '';
  const sessionKey = event.sessionKey != null ? String(event.sessionKey) : '';
  const seq = event.seq != null ? String(event.seq) : '';
  return ['delta', runId, sessionKey, seq, stableGatewayEventFingerprint(event.message ?? event)].join('|');
}
