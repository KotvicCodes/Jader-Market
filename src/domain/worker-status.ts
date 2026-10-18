import { readFile, rename, writeFile } from "node:fs/promises";

export type WorkerStatus = { lastSuccess: number | null; checkedAt: number; consecutiveFailures: number };
export async function readWorkerStatus(path: string): Promise<WorkerStatus | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!Number.isSafeInteger(value.checkedAt) || value.checkedAt <= 0 ||
        !(value.lastSuccess === null || Number.isSafeInteger(value.lastSuccess) && value.lastSuccess > 0 && value.lastSuccess <= value.checkedAt) ||
        !Number.isSafeInteger(value.consecutiveFailures) || value.consecutiveFailures < 0) return null;
    return value;
  } catch { return null; }
}
export async function recordWorkerStatus(path: string, success: boolean) {
  const previous = await readWorkerStatus(path);
  const now = Date.now();
  const value: WorkerStatus = { checkedAt: now, lastSuccess: success ? now : previous?.lastSuccess ?? null,
    consecutiveFailures: success ? 0 : Math.min((previous?.consecutiveFailures ?? 0) + 1, Number.MAX_SAFE_INTEGER) };
  await writeFile(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}
