import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, describe, expect, it } from 'vitest';
import type { HttpClient } from '../src/core/http-client.js';
import {
  MemoryRunStore,
  RunSchema,
  type StoredRun,
  StoredRunSchema,
} from '../src/core/run.js';
import {
  resolveSourceVariant,
  SelectionError,
  SOURCE_CATALOG,
  selectSources,
} from '../src/core/source-catalog.js';
import { createRunMcpServer } from '../src/mcp/run-server.js';
import { loadConfigV3, migrateConfigV1 } from '../src/node-config-v3.js';
import { FilesystemRunStore } from '../src/node-run-store.js';
import { checkRemoved, createRunCliProgram } from '../src/run-cli-program.js';
import { createLibrarium } from '../src/run-core-entry.js';
import { createLibrarium as createNodeLibrarium } from '../src/run-node-entry.js';
import { runStoreContract } from '../src/testing-entry.js';
import type { Provider } from '../src/types.js';

const require = createRequire(import.meta.url);
const spec = dirname(require.resolve('librarium-spec/package.json'));
const json = (path: string) =>
  JSON.parse(readFileSync(join(spec, path), 'utf8'));
const directories: string[] = [];
const temp = () => {
  const path = mkdtempSync(join(tmpdir(), 'librarium-run-'));
  directories.push(path);
  return path;
};
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});
const response = <T>(data: T) => ({
  status: 200,
  statusText: 'OK',
  data,
  headers: {},
  durationMs: 1,
});

describe('shared simplified contract', () => {
  for (const name of readdirSync(join(spec, 'fixtures/selection')).filter(
    (name) => name.endsWith('.json'),
  ))
    it(`selection: ${name}`, () => {
      const fixture = json(`fixtures/selection/${name}`);
      if (fixture.expected.error) {
        try {
          selectSources(fixture.setup, fixture.estimates, fixture.request);
          throw new Error('Expected selection failure');
        } catch (error) {
          expect(error).toBeInstanceOf(SelectionError);
          expect(error).toMatchObject({
            code: fixture.expected.error,
            ...(fixture.expected.name && { source: fixture.expected.name }),
          });
        }
      } else
        expect(
          selectSources(fixture.setup, fixture.estimates, fixture.request),
        ).toEqual(fixture.expected);
    });
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  ajv.addSchema(json('schema/run.schema.json'), 'run.schema.json');
  ajv.addSchema(
    json('schema/stored-run.schema.json'),
    'stored-run.schema.json',
  );
  for (const lane of ['valid', 'invalid'])
    for (const name of readdirSync(join(spec, `fixtures/runs/${lane}`)).filter(
      (name) => name.endsWith('.json'),
    ))
      it(`Run: ${lane}/${name}`, () => {
        const run = json(`fixtures/runs/${lane}/${name}`);
        expect(ajv.validate('run.schema.json', run)).toBe(lane === 'valid');
        expect(RunSchema.safeParse(run).success).toBe(lane === 'valid');
      });
  it('memory store passes the shared contract', async () => {
    await runStoreContract(new MemoryRunStore());
  });
  it('store contract permits different JSON object key ordering', async () => {
    const store = new MemoryRunStore();
    await runStoreContract({
      save: store.save.bind(store),
      list: store.list.bind(store),
      delete: store.delete.bind(store),
      async get(id) {
        const doc = await store.get(id);
        return doc
          ? {
              version: doc.version,
              files: doc.files,
              state: doc.state,
              run: doc.run,
            }
          : null;
      },
    });
  });
  it('filesystem passes the shared contract and reads the shared folder', async () => {
    const directory = temp();
    await runStoreContract(new FilesystemRunStore(directory));
    const incoming = temp();
    cpSync(join(spec, 'fixtures/run-store/filesystem'), incoming, {
      recursive: true,
    });
    const doc = await new FilesystemRunStore(incoming).get(
      json('fixtures/run-store/stored-run.json').run.id,
    );
    expect(doc).toEqual(json('fixtures/run-store/stored-run.json'));
    expect(ajv.validate('stored-run.schema.json', doc)).toBe(true);
    writeFileSync(
      join(incoming, doc?.run.id as string, 'state.json'),
      JSON.stringify({ state: {} }),
    );
    await expect(
      new FilesystemRunStore(incoming).get(doc?.run.id as string),
    ).rejects.toThrow();
  });
  it('invalid stored/config JSON never echoes secret contents', async () => {
    const directory = temp();
    const doc = json('fixtures/run-store/stored-run.json') as StoredRun;
    const store = new FilesystemRunStore(directory);
    await store.save(doc, null);
    for (const body of [
      '{"secret":"private-session-value",',
      JSON.stringify({
        version: 1,
        state: {},
        secret: 'private-session-value',
      }),
    ]) {
      writeFileSync(join(directory, doc.run.id, 'state.json'), body);
      await expect(store.get(doc.run.id)).rejects.toThrow(
        'file contents omitted',
      );
    }
    const path = join(directory, 'config.json');
    writeFileSync(path, '{"key":"private-session-value",');
    expect(() => loadConfigV3(path)).toThrow('file contents omitted');
    writeFileSync(
      path,
      JSON.stringify({ version: 3, max_cost: 'private-session-value' }),
    );
    expect(() => loadConfigV3(path)).toThrow(
      'Invalid v3 config; check sources',
    );
  });
  it('enforces exact decimal boundaries and expands skip groups', () => {
    const setup = {
      sources: ['exa', 'kagi', 'openai'],
      engines: { collector: 'searchapi', configured: true },
      groups: { excluded: ['kagi'] },
    };
    expect(
      selectSources(
        setup,
        { exa: '0.100000000000000001', openai: '0.2' },
        { question: 'q', skip: ['excluded'], max_cost: '0.3' },
      ),
    ).toEqual({
      selected: ['exa'],
      skipped: [
        { source: 'kagi', reason: 'excluded' },
        { source: 'openai', reason: 'over_budget' },
      ],
      estimated: '0.100000000000000001',
    });
  });
  it('maps depth-specific and collector-specific options', () => {
    const find = (id: string) =>
      SOURCE_CATALOG.find((source) => source.id === id)!;
    expect(
      resolveSourceVariant(find('perplexity'), 'deep', { deep_effort: 'high' })
        ?.js,
    ).toBe('perplexity-sonar-deep/research');
    expect(
      resolveSourceVariant(find('google'), 'quick', {
        collector: 'serpbase',
        vertical: 'news',
      })?.js,
    ).toBe('serpbase/news');
    expect(() =>
      resolveSourceVariant(find('google'), 'quick', { vertical: 'news' }),
    ).toThrow('combination');
  });
});

describe('Run lifecycle without network', () => {
  it('custom sources are client-scoped, engines named-only, and quick results survive concurrent readers', async () => {
    let release: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider: Provider = {
      id: 'local-provider',
      displayName: 'Local',
      tier: 'ai-grounded',
      envVar: '',
      requiresApiKey: false,
      execution: 'inline',
      test: async () => ({ ok: true }),
      async execute() {
        await ready;
        return {
          provider: 'local-provider',
          tier: 'ai-grounded',
          content: 'Custom answer',
          citations: [],
          durationMs: 5,
          usage: { costUsdDecimal: '0.100000000000000001' },
        };
      },
    };
    const store = new MemoryRunStore();
    const handleKey = new Uint8Array(32).fill(1);
    const customSources = [
      { id: 'local', quick: provider },
      {
        id: 'surface',
        engine: true,
        quick: { ...provider, id: 'surface-provider' },
      },
    ];
    const first = createLibrarium({ store, handleKey, customSources });
    const run = await first.research('q', { wait: false });
    await expect
      .poll(async () => (await store.get(run.id))?.run.results[0].status)
      .toBe('running');
    const reader = createLibrarium({ store, handleKey, customSources });
    expect((await reader.get(run.id))?.status).toBe('running');
    expect(run.results.map((result) => result.source)).toEqual(['local']);
    release?.();
    expect((await first.get(run.id, { wait: true }))?.cost.reported).toBe(
      '0.100000000000000001',
    );
    const surface = await reader.research('q', { only: ['surface'] });
    expect(surface.results[0].observation).toBe('surface');
    expect(
      createLibrarium()
        .sources()
        .some((source) => source.id === 'local'),
    ).toBe(false);
  });
  it('maps flat source options to the exact adapter rather than the family id', async () => {
    const calls: unknown[] = [];
    const client = createLibrarium({
      env: {
        OPENAI_API_KEY: 'dummy-openai',
        PARALLEL_API_KEY: 'dummy-parallel',
        VALYU_API_KEY: 'dummy-valyu',
      },
      httpClient: async (_url, options) => {
        calls.push(options?.body);
        return response({
          output: [
            {
              type: 'message',
              content: [
                { type: 'output_text', text: 'Mapped answer', annotations: [] },
              ],
            },
          ],
          model: 'gpt-5.5',
        }) as never;
      },
    });
    expect(
      (await client.research('q', { only: ['openai'] })).results[0].answer,
    ).toBe('Mapped answer');
    expect(calls).toHaveLength(1);
    const plan = await client.research('q', {
      depth: 'deep',
      only: ['parallel', 'valyu'],
      options: {
        parallel: { processor: 'ultra' },
        valyu: { mode: 'heavy', output: ['markdown'] },
      },
      dryRun: true,
    });
    expect(plan.cost.estimated).toBe('2.8');
    expect(plan.results.map((result) => result.provenance.variant)).toEqual([
      'research',
      'research',
    ]);
  });
  it('redacts question credentials from every store-bound document and rejects tampered handles', async () => {
    const store = new MemoryRunStore();
    const saved: StoredRun[] = [];
    const client = createLibrarium({
      store: {
        get: store.get.bind(store),
        list: store.list.bind(store),
        delete: store.delete.bind(store),
        async save(doc, expected) {
          saved.push(structuredClone(doc));
          return store.save(doc, expected);
        },
      },
      env: { KAGI_API_KEY: 'private-test-key' },
      httpClient: async () =>
        response({ data: { output: 'Answer', references: [] } }) as never,
    });
    const run = await client.research('question private-test-key');
    expect(JSON.stringify(saved)).not.toContain('private-test-key');
    expect(run.question).toContain('[REDACTED]');
    const doc = (await store.get(run.id)) as StoredRun;
    doc.run.status = 'running';
    doc.run.finished_at = null;
    doc.state.prepared = {};
    await store.save(doc, doc.version);
    await expect(client.get(run.id)).rejects.toThrow('signature');
  });
  it('summary uses fixed/configured source precedence, tracks verification and leaves source Run unchanged', async () => {
    const store = new MemoryRunStore();
    const original = json('fixtures/run-store/stored-run.json') as StoredRun;
    await store.save(original, null);
    const urls: string[] = [];
    let call = 0;
    const httpClient: HttpClient = async (url) => {
      urls.push(String(url));
      call++;
      return response({
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: call === 1 ? 'Draft' : 'Verified summary',
                annotations: [
                  {
                    type: 'url_citation',
                    url: 'https://example.org/evidence',
                    title: 'Evidence',
                  },
                ],
              },
            ],
          },
        ],
      }) as never;
    };
    const client = createLibrarium({
      store,
      env: {
        OPENAI_API_KEY: 'dummy-openai',
        ANTHROPIC_API_KEY: 'dummy-claude',
      },
      httpClient,
    });
    const summary = await client.summarize(original.run, { verify: true });
    expect(summary.summary_of).toBe(original.run.id);
    expect(summary.results[0].source).toBe('openai');
    expect(summary.results[0].answer).toBe('Verified summary');
    expect(summary.results[0].citations[0].url).toBe(
      'https://example.org/evidence',
    );
    expect(summary.cost).toMatchObject({ reported: null, complete: false });
    expect(urls).toEqual([
      'https://api.openai.com/v1/responses',
      'https://api.openai.com/v1/responses',
    ]);
    expect(await store.get(original.run.id)).toEqual(original);
    const configured = createLibrarium({
      store,
      config: { version: 3, summarize: { source: 'openai' } },
      env: { OPENAI_API_KEY: 'dummy-openai' },
      httpClient,
    });
    expect(
      (await configured.summarize(original.run, { source: 'claude' }))
        .results[0].source,
    ).toBe('openai');
    await expect(createLibrarium().summarize(original.run)).rejects.toThrow(
      'no_summarize_source',
    );
  });
  it('unavailable variants and invalid options fail without saving or dispatch', async () => {
    const store = new MemoryRunStore();
    const client = createLibrarium({
      store,
      env: { PERPLEXITY_API_KEY: 'dummy' },
      httpClient: async () => {
        throw new Error('Must not call');
      },
    });
    await expect(
      client.research('q', {
        only: ['perplexity'],
        options: { perplexity: { quick: 'agent' } },
        dryRun: true,
      }),
    ).rejects.toThrow('unavailable');
    await expect(
      client.research('q', { options: { perplexity: { unknown: 'x' } } }),
    ).rejects.toThrow('Unknown option');
    expect(await store.list()).toEqual([]);
  });
  it('dry run neither dispatches nor stores, and unknown costs stay null', async () => {
    const store = new MemoryRunStore();
    const client = createLibrarium({
      store,
      env: { KAGI_API_KEY: 'dummy' },
      httpClient: async () => {
        throw new Error('Network forbidden');
      },
    });
    const run = await client.research('question', { dryRun: true });
    expect(run.status).toBe('planned');
    expect(run.cost.reported).toBeNull();
    expect(await store.list()).toEqual([]);
  });
  it('redacts the credential selected by a per-request collector override', async () => {
    const store = new MemoryRunStore();
    const run = await createLibrarium({
      store,
      env: { SERPAPI_API_KEY: 'selected-collector-key' },
      httpClient: async () =>
        response({
          organic_results: [
            {
              link: 'https://example.com',
              title: 'selected-collector-key',
              snippet: 'Evidence',
            },
          ],
        }) as never,
    }).research('q selected-collector-key', {
      only: ['google'],
      options: { google: { collector: 'serpapi' } },
    });
    expect(run.status).toBe('done');
    expect(run.question).toBe('q [REDACTED]');
    expect(JSON.stringify(await store.get(run.id))).not.toContain(
      'selected-collector-key',
    );
  });
  it('stores before dispatch and redacts evidence before a custom store receives it', async () => {
    const store = new MemoryRunStore();
    const saved: StoredRun[] = [];
    const wrapped = {
      get: store.get.bind(store),
      list: store.list.bind(store),
      delete: store.delete.bind(store),
      async save(doc: StoredRun, version: number | null) {
        saved.push(structuredClone(doc));
        return store.save(doc, version);
      },
    };
    const httpClient: HttpClient = async () => {
      expect((await store.list())[0].status).toBe('running');
      return response({
        data: {
          output: 'Answer dummy-private-key',
          references: [
            {
              url: 'https://example.com/?api_key=dummy-private-key',
              title: 'Evidence',
            },
          ],
        },
        authorization: 'Bearer dummy-private-key',
        token: 'unknown-bare-token',
        sessionToken: 'unknown-session-secret',
        nested: { client_secret_payload: 'unknown-client-secret' },
      }) as never;
    };
    const run = await createLibrarium({
      store: wrapped,
      env: { KAGI_API_KEY: 'dummy-private-key' },
      httpClient,
    }).research('question');
    expect(run.status).toBe('done');
    expect(run.cost.reported).toBeNull();
    expect(run.cost.complete).toBe(false);
    expect(run.results[0].answer).toContain('[REDACTED]');
    expect(JSON.stringify(saved)).not.toContain('dummy-private-key');
    expect(JSON.stringify(saved)).not.toContain('unknown-bare-token');
    expect(JSON.stringify(saved)).not.toContain('unknown-session-secret');
    expect(JSON.stringify(saved)).not.toContain('unknown-client-secret');
    expect(StoredRunSchema.safeParse(await store.get(run.id)).success).toBe(
      true,
    );
    const evidence = JSON.parse(
      (await store.get(run.id))!.files['evidence/kagi.json'],
    );
    expect(evidence).toMatchObject({
      data: { output: 'Answer [REDACTED]' },
      token: '[REDACTED]',
      sessionToken: '[REDACTED]',
      nested: { client_secret_payload: '[REDACTED]' },
    });
  });
  it('resumes a signed deep handle after a filesystem/client restart, without resubmission', async () => {
    const store = new FilesystemRunStore(temp());
    const handleKey = new Uint8Array(32).fill(7);
    let submits = 0;
    let complete = false;
    const httpClient: HttpClient = async (_url, options) => {
      if (options?.method === 'POST') submits++;
      const done = complete && options?.method !== 'POST';
      return response({
        id: 'agent_run_test',
        object: 'agent_run',
        status: done ? 'completed' : 'running',
        createdAt: new Date().toISOString(),
        completedAt: done ? new Date().toISOString() : null,
        output: {
          text: done ? 'Findings' : '',
          structured: null,
          grounding: [
            { citations: [{ url: 'https://example.com', title: 'Evidence' }] },
          ],
        },
        usage: {},
        ...(done && { costDollars: { total: 0.74184 } }),
      }) as never;
    };
    const first = createLibrarium({
      store,
      handleKey,
      env: { EXA_API_KEY: 'dummy' },
      httpClient,
    });
    const initial = await first.research('question', {
      depth: 'deep',
      wait: false,
    });
    await expect
      .poll(async () => (await store.get(initial.id))?.state.handles, {
        timeout: 5000,
      })
      .toHaveProperty('exa');
    complete = true;
    const restarted = createLibrarium({
      store,
      handleKey,
      env: { EXA_API_KEY: 'dummy' },
      httpClient,
    });
    const run = await restarted.get(initial.id, { wait: true });
    expect(run?.status).toBe('done');
    expect(run?.results[0].answer).toBe('Findings');
    expect(run?.cost).toMatchObject({ reported: '0.74184', complete: true });
    expect(submits).toBe(1);
    const doc = await store.get(initial.id);
    expect(doc?.state.handles).toHaveProperty('exa');
    expect(doc?.files['answers/exa.md']).toBe('Findings');
    expect(
      JSON.parse(
        readFileSync(join(store.path, initial.id, 'run.json'), 'utf8'),
      ),
    ).toEqual(run);
  });
});

describe('new public transports', () => {
  for (const name of readdirSync(
    join(import.meta.dirname, 'fixtures/config-migration'),
  ).filter((name) => name.endsWith('.json')))
    it(`config migration fixture: ${name}`, () => {
      const fixture = JSON.parse(
        readFileSync(
          join(import.meta.dirname, 'fixtures/config-migration', name),
          'utf8',
        ),
      );
      const path = join(temp(), 'config.json');
      const original = JSON.stringify(fixture.input);
      writeFileSync(path, original);
      if (fixture.error) {
        expect(() => loadConfigV3(path)).toThrow(fixture.error);
        expect(readFileSync(path, 'utf8')).toBe(original);
      } else {
        expect(migrateConfigV1(fixture.input).config).toMatchObject(
          fixture.expected,
        );
        expect(loadConfigV3(path)).toMatchObject(fixture.expected);
        expect(readFileSync(`${path}.v1.backup`, 'utf8')).toBe(original);
      }
    });
  it('CLI exposes only the new command tree and replacements name the new surface', () => {
    expect(
      createRunCliProgram().commands.map((command) => command.name()),
    ).toEqual([
      'research',
      'show',
      'summarize',
      'sources',
      'groups',
      'setup',
      'mcp',
      'browse',
      'jsonl',
      'html',
      'usage',
      'cleanup',
      'config',
      'upgrade',
      'install-skill',
      'completions',
    ]);
    expect(() => checkRemoved(['run', 'q'])).toThrow('research');
    expect(() =>
      checkRemoved(['research', 'q', '--max-estimated-cost=1']),
    ).toThrow('--max-cost');
  });
  it('MCP has exactly three tools, honors the cap and calls list_sources offline', async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'offline', version: '1' });
    const server = createRunMcpServer({
      client: createLibrarium({
        env: { EXA_API_KEY: 'dummy' },
        httpClient: async () => {
          throw new Error('Network forbidden');
        },
      }),
      maxCost: '1',
    });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        'research',
        'get_run',
        'list_sources',
      ]);
      expect(tools.tools[0].inputSchema.properties?.wait_seconds).toMatchObject(
        { default: 45, maximum: 50 },
      );
      const listed = await client.callTool({
        name: 'list_sources',
        arguments: {},
      });
      expect(
        JSON.parse((listed.content as { text: string }[])[0].text).sources,
      ).toHaveLength(21);
      const denied = await client.callTool({
        name: 'research',
        arguments: { question: 'q', max_cost: '2', dry_run: true },
      });
      expect(denied.isError).toBe(true);
      const planned = await client.callTool({
        name: 'research',
        arguments: { question: 'q', dry_run: true, wait_seconds: 0 },
      });
      expect(planned.structuredContent).toMatchObject({ status: 'planned' });
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('MCP wait deadline returns a running summary when observation is blocked', async () => {
    const run = structuredClone(json('fixtures/run-store/stored-run.json').run);
    run.status = 'running';
    run.finished_at = null;
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'deadline', version: '1' });
    const server = createRunMcpServer({
      client: {
        research: async () => run,
        get: async () => new Promise(() => {}),
        sources: () => [],
        summarize: async () => {
          throw new Error('unused');
        },
      },
    });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    try {
      const started = Date.now();
      expect(
        (
          await client.callTool({
            name: 'research',
            arguments: { question: 'q', wait_seconds: 1 },
          })
        ).structuredContent,
      ).toMatchObject({ id: run.id, status: 'running' });
      expect(Date.now() - started).toBeLessThan(2500);
      expect(
        (
          await client.callTool({
            name: 'research',
            arguments: { question: 'q', wait_seconds: 51 },
          })
        ).isError,
      ).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('v1 config migrates with an exact backup and drops modes/fallbacks', () => {
    const path = join(temp(), 'config.json');
    const v1 = {
      providers: {
        'grok-combined': { apiKey: '$XAI_API_KEY', enabled: true },
        exa: { apiKey: '$EXA_API_KEY', enabled: true, fallback: 'kagi' },
      },
      defaults: { mode: 'mixed', maxEstimatedCost: 0.3 },
      groups: { mine: ['exa', 'grok-combined'], visibility: [] },
    };
    const original = JSON.stringify(v1);
    writeFileSync(path, original);
    const notices: string[] = [];
    const config = loadConfigV3(path, (notice) => notices.push(notice));
    expect(config.version).toBe(3);
    expect(config.sources.grok).toEqual({
      key: 'env:XAI_API_KEY',
      enabled: true,
      search: 'both',
    });
    expect(config.groups.mine).toEqual(['exa', 'grok']);
    expect(config.groups.visibility).toHaveLength(5);
    expect(config.max_cost).toBe('0.3');
    expect(readFileSync(`${path}.v1.backup`, 'utf8')).toBe(original);
    expect(notices.join(' ')).toContain('mode');
    expect(loadConfigV3(path)).toEqual(config);
  });
  it('loads a custom module store relative to the config path', async () => {
    const directory = temp();
    const module = join(directory, 'store.mjs');
    writeFileSync(
      module,
      'export default () => ({get: async () => null, save: async () => 1, list: async () => [], delete: async () => {}})',
    );
    const client = createNodeLibrarium({
      configPath: join(directory, 'config.json'),
      config: { version: 3, runs: { store: { module: './store.mjs' } } },
      env: {},
    });
    expect(await client.get('run_01JAB2C3D4E5F6G7H8J9K0M1N2')).toBeNull();
  });
});
