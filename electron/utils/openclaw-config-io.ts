import { access, mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { constants } from 'fs';
import { dirname } from 'path';

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureParentDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

export async function readJsonFileAllowMissing<T>(path: string): Promise<T | null> {
  if (!(await fileExists(path))) {
    return null;
  }

  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw) as T;
}

export async function writeJsonFileAtomic(path: string, data: unknown): Promise<void> {
  await ensureParentDir(path);

  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  const payload = JSON.stringify(data, null, 2);

  try {
    await writeFile(tempPath, payload, 'utf-8');
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
