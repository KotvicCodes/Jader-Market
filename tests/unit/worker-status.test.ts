import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readWorkerStatus, recordWorkerStatus } from "../../src/domain/worker-status";

it("preserves the last successful pass across failure/restart and resets failure count on recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jader-heartbeat-"));
  const file = join(directory, "status.json");
  try {
    expect(await readWorkerStatus(file)).toBeNull();
    await recordWorkerStatus(file, false);
    expect(await readWorkerStatus(file)).toMatchObject({ lastSuccess: null, consecutiveFailures: 1 });
    await recordWorkerStatus(file, true);
    const success = (await readWorkerStatus(file))!.lastSuccess;
    await recordWorkerStatus(file, false);
    await recordWorkerStatus(file, false);
    expect(await readWorkerStatus(file)).toMatchObject({ lastSuccess: success, consecutiveFailures: 2 });
    await recordWorkerStatus(file, true);
    expect(await readWorkerStatus(file)).toMatchObject({ consecutiveFailures: 0 });
    await writeFile(file, '{"checkedAt":1,"lastSuccess":2,"consecutiveFailures":0}');
    expect(await readWorkerStatus(file)).toBeNull();
    await writeFile(file, "incomplete");
    expect(await readWorkerStatus(file)).toBeNull();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
