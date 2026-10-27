import * as core from 'librarium/core';
import { expect, it } from 'vitest';

it('exports only the runtime-neutral simplified surface in workerd', () => {
  expect(Object.keys(core).sort()).toEqual(
    [
      'ConfigV3Schema',
      'MemoryRunStore',
      'RunSchema',
      'RunStoreConflict',
      'StoredRunSchema',
      'VERSION',
      'createLibrarium',
    ].sort(),
  );
});
