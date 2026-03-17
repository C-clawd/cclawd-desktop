import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface OpenClawEnvEntry {
  key: string;
  value: string;
}

type ParsedLine =
  | { type: 'raw'; raw: string }
  | { type: 'entry'; key: string; quote: '"' | '\'' | null };

const OPENCLAW_DIR = join(homedir(), '.openclaw');
const OPENCLAW_ENV_PATH = join(OPENCLAW_DIR, '.env');

function inferLineEnding(raw: string): '\n' | '\r\n' {
  return raw.includes('\r\n') ? '\r\n' : '\n';
}

function parseValue(rawValue: string): { value: string; quote: '"' | '\'' | null } {
  const trimmed = rawValue.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return {
      value: trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\'),
      quote: '"',
    };
  }
  if (trimmed.length >= 2 && trimmed.startsWith('\'') && trimmed.endsWith('\'')) {
    return {
      value: trimmed.slice(1, -1).replace(/\\'/g, '\'').replace(/\\\\/g, '\\'),
      quote: '\'',
    };
  }
  return { value: trimmed, quote: null };
}

function encodeValue(value: string, preferredQuote: '"' | '\'' | null): string {
  if (preferredQuote === '\'') {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`;
  }
  if (preferredQuote === '"') {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  if (!value) return '""';
  if (/[\s#=]/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}

function parseEnv(raw: string): { lines: ParsedLine[]; entries: OpenClawEnvEntry[] } {
  const lines = raw.split(/\r?\n/);
  const parsed: ParsedLine[] = [];
  const entries: OpenClawEnvEntry[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      parsed.push({ type: 'raw', raw: line });
      continue;
    }
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) {
      parsed.push({ type: 'raw', raw: line });
      continue;
    }
    const key = match[1];
    const { value, quote } = parseValue(match[2] ?? '');
    parsed.push({ type: 'entry', key, quote });
    if (!seen.has(key)) {
      entries.push({ key, value });
      seen.add(key);
    }
  }

  return { lines: parsed, entries };
}

function sanitizeEntries(entries: OpenClawEnvEntry[]): OpenClawEnvEntry[] {
  const result: OpenClawEnvEntry[] = [];
  const seen = new Set<string>();
  for (const item of entries) {
    const key = item.key.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (seen.has(key)) continue;
    result.push({ key, value: item.value ?? '' });
    seen.add(key);
  }
  return result;
}

function mergeEnv(
  parsed: ParsedLine[],
  nextEntries: OpenClawEnvEntry[],
  lineEnding: '\n' | '\r\n',
): string {
  const nextMap = new Map<string, string>(nextEntries.map((item) => [item.key, item.value]));
  const written = new Set<string>();
  const out: string[] = [];

  for (const line of parsed) {
    if (line.type === 'raw') {
      out.push(line.raw);
      continue;
    }
    const nextValue = nextMap.get(line.key);
    if (nextValue === undefined) {
      continue;
    }
    out.push(`${line.key}=${encodeValue(nextValue, line.quote)}`);
    written.add(line.key);
  }

  for (const entry of nextEntries) {
    if (written.has(entry.key)) continue;
    out.push(`${entry.key}=${encodeValue(entry.value, null)}`);
  }

  while (out.length > 0 && out[out.length - 1].trim() === '') {
    out.pop();
  }

  return `${out.join(lineEnding)}${lineEnding}`;
}

async function ensureOpenClawDir(): Promise<void> {
  await mkdir(OPENCLAW_DIR, { recursive: true });
}

export function getOpenClawEnvPath(): string {
  return OPENCLAW_ENV_PATH;
}

async function readOpenClawEnvRaw(): Promise<string> {
  try {
    return await readFile(OPENCLAW_ENV_PATH, 'utf-8');
  } catch {
    return '';
  }
}

export async function readOpenClawEnv(): Promise<{ path: string; entries: OpenClawEnvEntry[] }> {
  await ensureOpenClawDir();
  const raw = await readOpenClawEnvRaw();
  const { entries } = parseEnv(raw);
  return { path: OPENCLAW_ENV_PATH, entries };
}

export async function writeOpenClawEnv(entries: OpenClawEnvEntry[]): Promise<{ path: string; entries: OpenClawEnvEntry[] }> {
  await ensureOpenClawDir();
  const nextEntries = sanitizeEntries(entries);
  const previousRaw = await readOpenClawEnvRaw();
  const { lines } = parseEnv(previousRaw);
  const nextRaw = mergeEnv(lines, nextEntries, inferLineEnding(previousRaw));
  await writeFile(OPENCLAW_ENV_PATH, nextRaw, 'utf-8');
  return {
    path: OPENCLAW_ENV_PATH,
    entries: nextEntries,
  };
}
