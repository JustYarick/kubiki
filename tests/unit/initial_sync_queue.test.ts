import { expect, it } from 'vitest';
import { InitialSyncQueue } from '../../src/providers/initial_sync_queue';

it('limits in-flight initial collections until they finish and skips cancelled queued work', async () => {
  const queue = new InitialSyncQueue(2);
  const finish: (() => void)[] = [];
  const signals = Array.from({ length: 6 }, () => new AbortController());
  let started = 0;
  const results = signals.map(controller => queue.run(() => new Promise<void>(resolve => { started++; finish.push(resolve); }), controller.signal));
  expect(started).toBe(2);
  signals[2].abort();
  finish.shift()!(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(started).toBe(3);
  signals[4].abort(); signals[5].abort();
  while (finish.length) finish.shift()!();
  await Promise.all(results);
  expect(started).toBe(3);
});
