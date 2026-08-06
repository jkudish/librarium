import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('custom providers', () => {
  let tmpDir: string;
  let originalCwd: string;
  let initializeProviders: typeof import('../src/adapters/node-registry.js').initializeProviders;
  let getProvider: typeof import('../src/adapters/node-registry.js').getProvider;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `librarium-custom-${randomUUID().slice(0, 8)}`);
    mkdirSync(tmpDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    vi.resetModules();
    const adapters = await import('../src/adapters/node-registry.js');
    initializeProviders = adapters.initializeProviders;
    getProvider = adapters.getProvider;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('skips untrusted custom providers', async () => {
    const modulePath = join(tmpDir, 'untrusted-provider.mjs');
    writeFileSync(
      modulePath,
      [
        'export default {',
        "  id: 'untrusted-provider',",
        "  displayName: 'Untrusted Provider',",
        "  tier: 'raw-search',",
        "  execution: 'inline',",
        "  envVar: '',",
        '  requiresApiKey: false,',
        '  async execute(query) {',
        "    return { provider: 'untrusted-provider', tier: 'raw-search', content: query, citations: [], durationMs: 1 };",
        '  },',
        '};',
        '',
      ].join('\n'),
      'utf-8',
    );

    const result = await initializeProviders({
      providers: {
        'untrusted-provider': {
          enabled: true,
        },
      },
      customProviders: {
        'untrusted-provider': {
          type: 'npm',
          module: modulePath,
        },
      },
      trustedProviderIds: [],
    });

    expect(result.loadedCustomProviders).toEqual([]);
    expect(result.skippedCustomProviders).toContain('untrusted-provider');
    expect(result.warnings.join('\n')).toContain('not trusted');
    expect(getProvider('untrusted-provider')).toBeUndefined();
  });

  it('loads trusted npm provider from project node_modules', async () => {
    const pkgDir = join(tmpDir, 'node_modules', 'my-provider');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'tmp-project', private: true }, null, 2),
      'utf-8',
    );
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify(
        {
          name: 'my-provider',
          version: '1.0.0',
          type: 'module',
          exports: './index.mjs',
        },
        null,
        2,
      ),
      'utf-8',
    );
    writeFileSync(
      join(pkgDir, 'index.mjs'),
      [
        'export async function factory(context) {',
        '  return {',
        '    id: context.id,',
        "    displayName: 'My NPM Provider',",
        "    tier: 'ai-grounded',",
        "    execution: 'inline',",
        "    envVar: '',",
        '    requiresApiKey: false,',
        '    async execute(query) {',
        '      return {',
        '        provider: context.id,',
        "        tier: 'ai-grounded',",
        '        content: `${query}:${context.sourceOptions.suffix}`,',
        '        citations: [],',
        '        durationMs: 5,',
        '      };',
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );

    const result = await initializeProviders({
      providers: {
        'my-provider': {
          enabled: true,
        },
      },
      customProviders: {
        'my-provider': {
          type: 'npm',
          module: 'my-provider',
          export: 'factory',
          options: { suffix: 'ok' },
        },
      },
      trustedProviderIds: ['my-provider'],
    });

    expect(result.warnings).toEqual([]);
    expect(result.loadedCustomProviders).toContain('my-provider');

    const provider = getProvider('my-provider');
    expect(provider).toBeDefined();
    expect(provider!.source).toBe('npm');
    expect(provider!.requiresApiKey).toBe(false);

    const executed = await provider!.execute('hello', { timeout: 10 });
    expect(executed.content).toBe('hello:ok');
  });

  it('loads script provider with async lifecycle hooks', async () => {
    const scriptPath = join(tmpDir, 'script-provider.mjs');
    writeFileSync(
      scriptPath,
      [
        "import { readFileSync } from 'node:fs';",
        'const input = JSON.parse(readFileSync(0, "utf-8"));',
        'const op = input.operation;',
        'const providerId = input.providerId;',
        'const sourceTag = input.sourceOptions?.tag ?? "none";',
        'if (op === "describe") {',
        '  process.stdout.write(JSON.stringify({',
        '    ok: true,',
        '    data: {',
        "      displayName: 'Script Provider',",
        "      tier: 'deep-research',",
        "      execution: 'background',",
        "      envVar: '',",
        '      requiresApiKey: false,',
        '      capabilities: { execute: true, submit: true, poll: true, retrieve: true, test: true }',
        '    }',
        '  }));',
        '} else if (op === "execute") {',
        '  process.stdout.write(JSON.stringify({',
        '    ok: true,',
        '    data: {',
        '      provider: providerId,',
        "      tier: 'deep-research',",
        '      content: `exec:${input.query}:${sourceTag}`,',
        '      citations: [],',
        '      durationMs: 2',
        '    }',
        '  }));',
        '} else if (op === "submit") {',
        '  process.stdout.write(JSON.stringify({',
        '    ok: true,',
        '    data: {',
        '      provider: providerId,',
        "      taskId: 'task-123',",
        '      query: input.query,',
        '      submittedAt: Date.now(),',
        "      status: 'pending'",
        '    }',
        '  }));',
        '} else if (op === "poll") {',
        '  process.stdout.write(JSON.stringify({',
        '    ok: true,',
        '    data: {',
        "      status: 'completed',",
        '      progress: 100',
        '    }',
        '  }));',
        '} else if (op === "retrieve") {',
        '  process.stdout.write(JSON.stringify({',
        '    ok: true,',
        '    data: {',
        '      provider: providerId,',
        "      tier: 'deep-research',",
        '      content: `retrieved:${input.handle.taskId}`,',
        '      citations: [],',
        '      durationMs: 3',
        '    }',
        '  }));',
        '} else if (op === "test") {',
        '  process.stdout.write(JSON.stringify({',
        '    ok: true,',
        '    data: { ok: true }',
        '  }));',
        '} else {',
        '  process.stdout.write(JSON.stringify({ ok: false, error: `unsupported:${op}` }));',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );

    const initResult = await initializeProviders({
      providers: {
        'script-provider': {
          enabled: true,
          apiKey: '$SCRIPT_PROVIDER_KEY',
        },
      },
      customProviders: {
        'script-provider': {
          type: 'script',
          command: 'node',
          args: [scriptPath],
          options: { tag: 'tagged' },
        },
      },
      trustedProviderIds: ['script-provider'],
    });

    expect(initResult.warnings).toEqual([]);
    const provider = getProvider('script-provider');
    expect(provider).toBeDefined();
    expect(provider!.source).toBe('script');
    expect(provider!.execution).toBe('background');
    expect(provider!.submit).toBeDefined();
    expect(provider!.poll).toBeDefined();
    expect(provider!.retrieve).toBeDefined();
    expect(provider!.test).toBeDefined();

    const executed = await provider!.execute('question', { timeout: 5 });
    expect(executed.provider).toBe('script-provider');
    expect(executed.tier).toBe('deep-research');
    expect(executed.content).toBe('exec:question:tagged');

    if (provider!.execution !== 'background')
      throw new Error('expected background provider');
    const handle = await provider!.submit('question', { timeout: 5 });
    expect(handle.provider).toBe('script-provider');
    const pollResult = await provider!.poll(handle);
    expect(pollResult.status).toBe('completed');
    const retrieved = await provider!.retrieve(handle);
    expect(retrieved.content).toBe('retrieved:task-123');
    const health = await provider!.test!();
    expect(health.ok).toBe(true);
  });

  it('skips malformed script providers', async () => {
    const scriptPath = join(tmpDir, 'bad-script-provider.mjs');
    writeFileSync(scriptPath, 'process.stdout.write("not-json");\n', 'utf-8');

    const initResult = await initializeProviders({
      providers: {
        'bad-script': {
          enabled: true,
        },
      },
      customProviders: {
        'bad-script': {
          type: 'script',
          command: 'node',
          args: [scriptPath],
        },
      },
      trustedProviderIds: ['bad-script'],
    });

    expect(initResult.loadedCustomProviders).toEqual([]);
    expect(initResult.skippedCustomProviders).toContain('bad-script');
    expect(initResult.warnings.join('\n')).toContain('invalid JSON');
  });

  it('rejects script background providers missing lifecycle hooks', async () => {
    const scriptPath = join(tmpDir, 'incomplete-background.mjs');
    writeFileSync(
      scriptPath,
      [
        "import { readFileSync } from 'node:fs';",
        'const input = JSON.parse(readFileSync(0, "utf-8"));',
        'if (input.operation === "describe") {',
        '  process.stdout.write(JSON.stringify({ ok: true, data: {',
        "    displayName: 'Incomplete Background', tier: 'deep-research', execution: 'background',",
        '    requiresApiKey: false, capabilities: { execute: true, submit: true, poll: true }',
        '  }}));',
        '}',
      ].join('\n'),
      'utf-8',
    );

    const result = await initializeProviders({
      providers: { incomplete: { enabled: true } },
      customProviders: {
        incomplete: { type: 'script', command: 'node', args: [scriptPath] },
      },
      trustedProviderIds: ['incomplete'],
    });

    expect(result.loadedCustomProviders).toEqual([]);
    expect(result.warnings.join('\n')).toContain(
      'must declare submit, poll, and retrieve',
    );
  });

  it('rejects script providers that require a key without envVar', async () => {
    const scriptPath = join(tmpDir, 'missing-env-var.mjs');
    writeFileSync(
      scriptPath,
      [
        "import { readFileSync } from 'node:fs';",
        'const input = JSON.parse(readFileSync(0, "utf-8"));',
        'if (input.operation === "describe") {',
        '  process.stdout.write(JSON.stringify({ ok: true, data: {',
        "    displayName: 'Missing Env', tier: 'raw-search', execution: 'inline',",
        '    capabilities: { execute: true }',
        '  }}));',
        '}',
      ].join('\n'),
      'utf-8',
    );

    const result = await initializeProviders({
      providers: { 'missing-env': { enabled: true } },
      customProviders: {
        'missing-env': { type: 'script', command: 'node', args: [scriptPath] },
      },
      trustedProviderIds: ['missing-env'],
    });

    expect(result.loadedCustomProviders).toEqual([]);
    expect(result.warnings.join('\n')).toContain(
      'requires an API key but envVar is empty',
    );
  });

  it('rejects inline script providers with lifecycle capabilities', async () => {
    const scriptPath = join(tmpDir, 'inline-lifecycle.mjs');
    writeFileSync(
      scriptPath,
      [
        "import { readFileSync } from 'node:fs';",
        'const input = JSON.parse(readFileSync(0, "utf-8"));',
        'if (input.operation === "describe") {',
        '  process.stdout.write(JSON.stringify({ ok: true, data: {',
        "    displayName: 'Inline Lifecycle', tier: 'raw-search', execution: 'inline',",
        '    requiresApiKey: false, capabilities: { execute: true, submit: true }',
        '  }}));',
        '}',
      ].join('\n'),
      'utf-8',
    );

    const result = await initializeProviders({
      providers: { 'inline-lifecycle': { enabled: true } },
      customProviders: {
        'inline-lifecycle': {
          type: 'script',
          command: 'node',
          args: [scriptPath],
        },
      },
      trustedProviderIds: ['inline-lifecycle'],
    });

    expect(result.loadedCustomProviders).toEqual([]);
    expect(result.warnings.join('\n')).toContain(
      'cannot declare submit, poll, or retrieve',
    );
  });

  it('rejects script providers that disable execute', async () => {
    const scriptPath = join(tmpDir, 'no-execute.mjs');
    writeFileSync(
      scriptPath,
      [
        "import { readFileSync } from 'node:fs';",
        'const input = JSON.parse(readFileSync(0, "utf-8"));',
        'if (input.operation === "describe") {',
        '  process.stdout.write(JSON.stringify({ ok: true, data: {',
        "    displayName: 'No Execute', tier: 'raw-search', execution: 'inline',",
        '    requiresApiKey: false, capabilities: { execute: false }',
        '  }}));',
        '}',
      ].join('\n'),
      'utf-8',
    );

    const result = await initializeProviders({
      providers: { 'no-execute': { enabled: true } },
      customProviders: {
        'no-execute': { type: 'script', command: 'node', args: [scriptPath] },
      },
      trustedProviderIds: ['no-execute'],
    });

    expect(result.loadedCustomProviders).toEqual([]);
    expect(result.warnings.join('\n')).toContain(
      'capabilities.execute must be true',
    );
  });

  it('rejects npm background providers missing lifecycle hooks', async () => {
    const modulePath = join(tmpDir, 'incomplete-background.mjs');
    writeFileSync(
      modulePath,
      [
        'export default {',
        "  id: 'incomplete-npm', displayName: 'Incomplete NPM', tier: 'deep-research',",
        "  execution: 'background', envVar: '', requiresApiKey: false,",
        '  async execute() { return { provider: "incomplete-npm", tier: "deep-research", content: "", citations: [], durationMs: 0 }; },',
        '  async submit(query) { return { provider: "incomplete-npm", taskId: "x", query, submittedAt: 0, status: "pending" }; },',
        '};',
      ].join('\n'),
      'utf-8',
    );

    const result = await initializeProviders({
      providers: { 'incomplete-npm': { enabled: true } },
      customProviders: {
        'incomplete-npm': { type: 'npm', module: modulePath },
      },
      trustedProviderIds: ['incomplete-npm'],
    });

    expect(result.loadedCustomProviders).toEqual([]);
    expect(result.warnings.join('\n')).toContain(
      'Background providers must define submit',
    );
  });

  it('rejects npm providers that omit their execution contract', async () => {
    const modulePath = join(tmpDir, 'missing-execution.mjs');
    writeFileSync(
      modulePath,
      [
        'export default {',
        "  id: 'missing-execution', displayName: 'Missing Execution', tier: 'raw-search',",
        "  envVar: '', requiresApiKey: false,",
        '  async execute() { return { provider: "missing-execution", tier: "raw-search", content: "", citations: [], durationMs: 0 }; },',
        '};',
      ].join('\n'),
      'utf-8',
    );

    const result = await initializeProviders({
      providers: { 'missing-execution': { enabled: true } },
      customProviders: {
        'missing-execution': { type: 'npm', module: modulePath },
      },
      trustedProviderIds: ['missing-execution'],
    });

    expect(result.loadedCustomProviders).toEqual([]);
    expect(result.warnings.join('\n')).toContain('must declare execution');
  });

  it('rejects inline npm providers with lifecycle hooks', async () => {
    const modulePath = join(tmpDir, 'inline-npm-lifecycle.mjs');
    writeFileSync(
      modulePath,
      [
        'export default {',
        "  id: 'inline-npm-lifecycle', displayName: 'Inline NPM Lifecycle', tier: 'raw-search',",
        "  execution: 'inline', envVar: '', requiresApiKey: false,",
        '  async execute() { return { provider: "inline-npm-lifecycle", tier: "raw-search", content: "", citations: [], durationMs: 0 }; },',
        '  async submit() {},',
        '};',
      ].join('\n'),
      'utf-8',
    );

    const result = await initializeProviders({
      providers: { 'inline-npm-lifecycle': { enabled: true } },
      customProviders: {
        'inline-npm-lifecycle': { type: 'npm', module: modulePath },
      },
      trustedProviderIds: ['inline-npm-lifecycle'],
    });

    expect(result.loadedCustomProviders).toEqual([]);
    expect(result.warnings.join('\n')).toContain(
      'Inline providers cannot define submit, poll, or retrieve',
    );
  });

  it('rejects custom providers that collide with built-in IDs', async () => {
    const modulePath = join(tmpDir, 'exa-override.mjs');
    writeFileSync(
      modulePath,
      [
        'export default {',
        "  id: 'exa',",
        "  displayName: 'Exa Override',",
        "  tier: 'ai-grounded',",
        "  execution: 'inline',",
        "  envVar: '',",
        '  requiresApiKey: false,',
        '  async execute(query, _options) {',
        "    return { provider: 'exa', tier: 'ai-grounded', content: query, citations: [], durationMs: 1 };",
        '  },',
        '};',
        '',
      ].join('\n'),
      'utf-8',
    );

    const initResult = await initializeProviders({
      providers: {
        exa: {
          enabled: true,
        },
      },
      customProviders: {
        exa: {
          type: 'npm',
          module: modulePath,
        },
      },
      trustedProviderIds: ['exa'],
    });

    const exa = getProvider('exa');
    expect(exa).toBeDefined();
    expect(exa!.source).toBe('builtin');
    expect(initResult.loadedCustomProviders).toEqual([]);
    expect(initResult.warnings.join('\n')).toContain(
      'conflicts with a built-in',
    );
  });
});
