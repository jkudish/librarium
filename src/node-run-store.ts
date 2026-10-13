import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { ConfigV3 } from './core/config-v3.js';
import { safeWriteFile } from './core/fs-utils.js';
import {
  listRuns,
  MemoryRunStore,
  RunIdSchema,
  type RunStore,
  RunStoreConflict,
  type StoredRun,
  StoredRunSchema,
} from './core/run.js';
import { withRunJsonLock } from './node-run-json-lock.js';

const StateFileSchema = z.strictObject({
  version: StoredRunSchema.shape.version,
  state: StoredRunSchema.shape.state,
});

/** Internal Node factory shared by the client and retained Run tools. */
export async function loadRunStore(
  config: ConfigV3,
  configPath: string,
): Promise<RunStore> {
  if (config.runs.store === 'filesystem')
    return new FilesystemRunStore(config.runs.path);
  if (config.runs.store === 'memory') return new MemoryRunStore();
  const module = config.runs.store.module;
  const location =
    module.startsWith('.') || module.startsWith('/')
      ? pathToFileURL(resolve(dirname(configPath), module)).href
      : module;
  const imported = await import(location);
  const store = (await imported.default(config.runs)) as RunStore;
  if (
    !store ||
    ['get', 'save', 'list', 'delete'].some(
      (method) =>
        typeof (store as unknown as Record<string, unknown>)[method] !==
        'function',
    )
  )
    throw new TypeError('Custom store must implement get/save/list/delete');
  return store;
}

/** Public Run in run.json; version and private state in state.json, committed last. */
export class FilesystemRunStore implements RunStore {
  readonly path: string;
  constructor(path: string) {
    this.path = resolve(path);
  }
  private directory(id: string) {
    RunIdSchema.parse(id);
    const directory = join(this.path, id);
    if (existsSync(directory) && lstatSync(directory).isSymbolicLink())
      throw new Error('Run directories must not be symbolic links');
    return directory;
  }
  private read(id: string): StoredRun | null {
    const directory = this.directory(id);
    if (!existsSync(join(directory, 'state.json'))) {
      if (existsSync(join(directory, 'run.json')))
        throw new Error('Run is missing its versioned state.json');
      return null;
    }
    for (const name of ['run.json', 'state.json'])
      if (
        !lstatSync(join(directory, name)).isFile() ||
        lstatSync(join(directory, name)).isSymbolicLink()
      )
        throw new Error('Run files must be regular files, not symbolic links');
    const readJson = (name: string) => {
      try {
        return JSON.parse(readFileSync(join(directory, name), 'utf8'));
      } catch {
        throw new Error(`Invalid stored ${name}; file contents omitted`);
      }
    };
    const envelope = StateFileSchema.safeParse(readJson('state.json'));
    if (!envelope.success)
      throw new Error('Invalid versioned state.json; file contents omitted');
    const { version, state } = envelope.data;
    const files: Record<string, string> = {};
    for (const folder of ['answers', 'evidence']) {
      const path = join(directory, folder);
      if (!existsSync(path)) continue;
      if (lstatSync(path).isSymbolicLink())
        throw new Error('Run files must not be symbolic links');
      for (const entry of readdirSync(path)) {
        const file = join(path, entry);
        if (lstatSync(file).isSymbolicLink())
          throw new Error('Run files must not be symbolic links');
        files[`${folder}/${entry}`] = readFileSync(file, 'utf8');
      }
    }
    const parsed = StoredRunSchema.safeParse({
      run: readJson('run.json'),
      state,
      files,
      version,
    });
    if (!parsed.success)
      throw new Error('Invalid StoredRun; file contents omitted');
    return parsed.data;
  }
  async get(id: string) {
    const directory = this.directory(id);
    if (!existsSync(directory)) return null;
    return withRunJsonLock(join(directory, 'run.json'), () => this.read(id));
  }
  async save(doc: StoredRun, expectedVersion: number | null) {
    const parsed = StoredRunSchema.parse(doc);
    const directory = this.directory(parsed.run.id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return withRunJsonLock(join(directory, 'run.json'), () => {
      const current = this.read(parsed.run.id);
      if ((current?.version ?? null) !== expectedVersion)
        throw new RunStoreConflict();
      const version = (expectedVersion ?? 0) + 1;
      safeWriteFile(
        join(directory, 'run.json'),
        JSON.stringify(parsed.run, null, 2),
        { mode: 0o600 },
      );
      for (const [name, content] of Object.entries(parsed.files)) {
        const folder = join(directory, name.split('/')[0]);
        if (existsSync(folder) && lstatSync(folder).isSymbolicLink())
          throw new Error('Run files must not be symbolic links');
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        safeWriteFile(join(directory, name), content, { mode: 0o600 });
      }
      for (const name of Object.keys(current?.files ?? {}))
        if (!(name in parsed.files)) rmSync(join(directory, name));
      safeWriteFile(
        join(directory, 'state.json'),
        JSON.stringify({ version, state: parsed.state }, null, 2),
        { mode: 0o600 },
      );
      return version;
    });
  }
  async list(opts?: { limit?: number; before?: string }) {
    if (!existsSync(this.path)) return [];
    const runs = await Promise.all(
      readdirSync(this.path)
        .filter((id) => RunIdSchema.safeParse(id).success)
        .map((id) => this.get(id)),
    );
    return listRuns(
      runs.flatMap((doc) => (doc ? [doc.run] : [])),
      opts,
    );
  }
  async delete(id: string) {
    const directory = this.directory(id);
    if (!existsSync(directory)) return;
    withRunJsonLock(join(directory, 'run.json'), () => {
      const entries = readdirSync(this.directory(id), {
        recursive: true,
        withFileTypes: true,
      });
      if (entries.some((entry) => entry.isSymbolicLink()))
        throw new Error('Run files must not be symbolic links');
      // Keep the directory tree and live marker until token-checked release.
      for (const entry of entries) {
        const file = join(entry.parentPath, entry.name);
        if (!entry.isDirectory() && file !== join(directory, 'run.json.lock'))
          rmSync(file, { force: true });
      }
    });
  }
}
