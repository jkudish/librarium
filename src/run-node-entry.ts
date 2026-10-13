import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  createLibrarium as createCoreLibrarium,
  type Librarium,
  type LibrariumOptions,
} from './core/librarium.js';
import { MemoryRunStore } from './core/run.js';
import { configV3Path, loadConfigV3 } from './node-config-v3.js';
import { createNodeCredentialContext } from './node-credentials.js';
import { FilesystemRunStore, loadRunStore } from './node-run-store.js';

export {
  configV3Path,
  loadConfigV3,
  migrateConfigV1,
  saveConfigV3,
} from './node-config-v3.js';
export { FilesystemRunStore } from './node-run-store.js';
export * from './run-core-entry.js';

export interface NodeLibrariumOptions extends LibrariumOptions {
  configPath?: string;
}
/** Node defaults: on-disk v3 config, environment credentials, filesystem RunStore. */
export function createLibrarium(options: NodeLibrariumOptions = {}): Librarium {
  const configPath = options.configPath ?? configV3Path();
  const config = options.config
    ? loadExplicit(options.config)
    : loadConfigV3(configPath, (notice) => process.stderr.write(`${notice}\n`));
  const keyPath = resolve(dirname(configPath), 'run-signing.key');
  function handleKey() {
    if (options.handleKey) return options.handleKey;
    mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
    if (!existsSync(keyPath)) {
      try {
        writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const key = readFileSync(keyPath);
    if (key.length !== 32) throw new Error('Invalid run signing key');
    return key;
  }
  let client: Librarium | undefined;
  let loading: Promise<Librarium> | undefined;
  const base = () => ({
    ...options,
    config,
    env: options.env ?? process.env,
    resolveCredential:
      options.resolveCredential ??
      createNodeCredentialContext(options.env ?? process.env).resolveCredential,
    owner: options.owner ?? {
      id: `${process.pid}`,
      alive(id: string) {
        if (!/^\d+$/.test(id)) return true;
        try {
          process.kill(Number(id), 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code !== 'ESRCH';
        }
      },
    },
  });
  const immediateStore =
    options.store ??
    (config.runs.store === 'memory'
      ? new MemoryRunStore()
      : typeof config.runs.store === 'string'
        ? new FilesystemRunStore(config.runs.path)
        : undefined);
  async function getClient() {
    if (client) return client;
    loading ??= (async () => {
      const store = immediateStore ?? (await loadRunStore(config, configPath));
      client = createCoreLibrarium({
        ...base(),
        store,
        handleKey: handleKey(),
      });
      return client;
    })();
    return loading;
  }
  return {
    async research(question, opts) {
      return (await getClient()).research(question, opts);
    },
    async get(id, opts) {
      return (await getClient()).get(id, opts);
    },
    sources() {
      return createCoreLibrarium(base()).sources();
    },
    async summarize(run, opts) {
      return (await getClient()).summarize(run, opts);
    },
  };
}

import { type ConfigV3Input, ConfigV3Schema } from './core/config-v3.js';

function loadExplicit(config: ConfigV3Input) {
  return ConfigV3Schema.parse(config);
}
