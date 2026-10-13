import { createLibrarium, MemoryRunStore } from 'librarium/core';
import { expect, it } from 'vitest';

it('researches through the installed runtime-neutral entry with a memory default', async () => {
  const store = new MemoryRunStore();
  const client = createLibrarium({
    store,
    env: { KAGI_API_KEY: 'dummy-worker' },
    httpClient: async <T>() => ({
      status: 200,
      statusText: 'OK',
      data: { data: { output: 'Worker answer', references: [] } } as T,
      headers: {},
      durationMs: 1,
    }),
  });
  const plan = await client.research('worker q', { dryRun: true });
  expect(plan.status).toBe('planned');
  expect(await store.list()).toEqual([]);
  const run = await client.research('worker q');
  expect(run.results[0].answer).toContain('Worker answer');
  expect((await client.get(run.id))?.status).toBe('done');
  expect(run.cost.reported).toBeNull();
});
