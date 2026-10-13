import {
  type AsyncPollResult,
  type AsyncTaskHandle,
  type Citation,
  type ConfigV3,
  type ConfigV3Input,
  ConfigV3Schema,
  type CustomSource,
  createLibrarium,
  type GetOptions,
  type HttpClient,
  type Librarium,
  type LibrariumOptions,
  MemoryRunStore,
  type Provider,
  type ProviderOptions,
  type ProviderResult,
  type ProviderUsage,
  type ResearchOptions,
  type Run,
  type RunResult,
  RunSchema,
  type RunStore,
  RunStoreConflict,
  type RunSummary,
  type StoredRun,
  StoredRunSchema,
} from 'librarium/core';

export type PublicInventory = [
  Librarium,
  LibrariumOptions,
  CustomSource,
  ResearchOptions,
  GetOptions,
  ConfigV3,
  ConfigV3Input,
  Run,
  RunResult,
  RunSummary,
  RunStore,
  StoredRun,
  Provider,
  ProviderOptions,
  ProviderResult,
  ProviderUsage,
  AsyncTaskHandle,
  AsyncPollResult,
  Citation,
  HttpClient,
];
const store: RunStore = new MemoryRunStore();
const client: Librarium = createLibrarium({ config: { version: 3 }, store });
const run: Promise<Run> = client.research('q', {
  depth: 'deep',
  only: ['exa'],
  maxCost: '1.00',
  wait: false,
});
const observed: Promise<Run | null> = client.get(
  'run_01JAB2C3D4E5F6G7H8J9K0M1N2',
  { wait: true },
);
void [
  run,
  observed,
  ConfigV3Schema,
  RunSchema,
  StoredRunSchema,
  RunStoreConflict,
];
// @ts-expect-error Runtime-neutral declarations do not supply Node globals.
process.version;
// @ts-expect-error Modes are not public request fields.
client.research('q', { mode: 'mixed' });
// @ts-expect-error Internal selector contracts are no longer public.
export type OldSelector = import('librarium/core').ResearchRequest;
