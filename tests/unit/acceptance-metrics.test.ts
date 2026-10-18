import { expect, it } from 'vitest';
import { lockWaitBounds } from '../../scripts/acceptance-metrics';

it('accounts for a lock wait that ends between samples',()=>{
  const bounds=lockWaitBounds([0,40,0],[1000,1050,1150],[0,50,150]);
  expect(bounds.lockWaitUpperBoundMs).toBe(140);
});

it('does not accept a subsecond clock step that could hide a 500 ms lock wait',()=>{
  const bounds=lockWaitBounds([0,20,0,25],[1000,1050,600,650],[0,50,100,150]);
  expect(bounds.clockDriftMs).toBeLessThan(1000);
  expect(bounds.lockWaitUpperBoundMs).toBeGreaterThanOrEqual(500);
  expect(bounds.maxSamplingGapMs).toBe(50);
});

it('bounds drift between opposite clock offsets rather than only from the initial sample',()=>{
  const bounds=lockWaitBounds([0,0,0],[1000,1250,900],[0,50,100]);
  expect(bounds.clockDriftMs).toBe(400);
});

it('rejects incomplete, nonfinite and reversed-clock measurements',()=>{
  expect(()=>lockWaitBounds([0],[1000],[0])).toThrow();
  expect(()=>lockWaitBounds([0,0],[1000],[0,50])).toThrow();
  expect(()=>lockWaitBounds([0,NaN],[1000,1050],[0,50])).toThrow();
  expect(()=>lockWaitBounds([0,0],[1000,1050],[50,0])).toThrow();
});
