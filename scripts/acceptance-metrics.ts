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
