import { type Run, createLibrarium as rootClient } from 'librarium';
import {
  configV3Path,
  createLibrarium,
  FilesystemRunStore,
  loadConfigV3,
  migrateConfigV1,
  type NodeLibrariumOptions,
  type RunStore,
  saveConfigV3,
} from 'librarium/node';
import { runStoreContract } from 'librarium/testing';

const store: RunStore = new FilesystemRunStore('./runs');
const options: NodeLibrariumOptions = { configPath: './config.json', store };
const client = createLibrarium(options);
const run: Promise<Run> = client.research('q', { dryRun: true });
void [
  run,
  rootClient,
  runStoreContract,
  loadConfigV3,
  saveConfigV3,
  migrateConfigV1,
  configV3Path,
];
// @ts-expect-error Config v2 never shipped and is not public.
export type OldConfig = import('librarium/node').LibrariumConfigV2;
