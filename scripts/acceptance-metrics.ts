import { sql } from 'drizzle-orm';
import type { Database } from '../src/db/transaction-lock';

/** Remaining payouts retain their original queue age when another batch completes. */
export async function oldestSettlementLagMs(db: Database) {
  const [row] = await db.execute<{ lag: number }>(sql`
    SELECT coalesce(max(extract(epoch FROM clock_timestamp() - r.created_at) * 1000), 0)::float8 AS lag
    FROM markets m JOIN market_resolutions r ON r.market_id = m.id WHERE m.status = 'settling'`);
  return row.lag;
}

/** Bound missed lock observations and observed wall-clock movement with monotonic time. */
export function lockWaitBounds(waits:number[],wallTimes:number[],monotonicTimes:number[]) {
  if(waits.length<2||waits.length!==wallTimes.length||waits.length!==monotonicTimes.length||
    [...waits,...wallTimes,...monotonicTimes].some(value=>!Number.isFinite(value))||
    waits.some(value=>value<0)||monotonicTimes.some((at,index)=>index>0&&at<monotonicTimes[index-1]))throw new Error('invalid_lock_measurements');
  const maxObservedLockWaitMs=Math.max(...waits);
  const maxSamplingGapMs=Math.max(...monotonicTimes.slice(1).map((at,index)=>at-monotonicTimes[index]));
  const offsets=wallTimes.map((at,index)=>at-monotonicTimes[index]);
  const clockDriftMs=Math.max(...offsets)-Math.min(...offsets);
  return {maxObservedLockWaitMs,maxSamplingGapMs,clockDriftMs,
    lockWaitUpperBoundMs:maxObservedLockWaitMs+maxSamplingGapMs+clockDriftMs};
}
