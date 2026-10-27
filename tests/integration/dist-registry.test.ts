import { expect, it } from 'vitest';

it('built public entries expose only the simplified client and stores', async () => {
  const root = await import('../../dist/index.js');
  const core = await import('../../dist/core.js');
  const node = await import('../../dist/node.js');
  expect(root.createLibrarium).toBeTypeOf('function');
  expect(node.FilesystemRunStore).toBeTypeOf('function');
  expect(core.MemoryRunStore).toBeTypeOf('function');
  for (const entry of [root, core, node])
    for (const removed of [
      'ResearchRequestSchema',
      'LibrariumConfigV2Schema',
      'registerProvider',
      'initializeProviders',
      'loadCustomProviders',
      'dispatch',
    ])
      expect(entry).not.toHaveProperty(removed);
  expect(Object.keys(core.createLibrarium()).sort()).toEqual([
    'get',
    'research',
    'sources',
    'summarize',
  ]);
});
