import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { detectInstallMethod } from '../core/install-method.js';
import type {
  AsyncTaskHandle,
  Config,
  NpmProviderSource,
  Provider,
  ProviderConfig,
  ProviderOptions,
  ProviderTier,
  ScriptProviderSource,
} from '../types.js';

const PROVIDER_TIER_SCHEMA = z.enum([
  'deep-research',
  'ai-grounded',
  'raw-search',
]);

const CITATION_SCHEMA = z.object({
  url: z.string(),
  title: z.string().optional(),
  snippet: z.string().optional(),
  provider: z.string(),
});

const PROVIDER_RESULT_SCHEMA = z.object({
  provider: z.string(),
  tier: PROVIDER_TIER_SCHEMA,
  content: z.string(),
  citations: z.array(CITATION_SCHEMA),
  durationMs: z.number().nonnegative(),
  model: z.string().optional(),
  tokenUsage: z
    .object({
      input: z.number().optional(),
      output: z.number().optional(),
    })
    .optional(),
  error: z.string().optional(),
});

const ASYNC_TASK_HANDLE_SCHEMA = z.object({
  provider: z.string(),
  taskId: z.string(),
  query: z.string(),
  submittedAt: z.number(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']),
  lastPolledAt: z.number().optional(),
  completedAt: z.number().optional(),
  outputDir: z.string().optional(),
});

const ASYNC_POLL_RESULT_SCHEMA = z.object({
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']),
  progress: z.number().optional(),
  message: z.string().optional(),
});

const SCRIPT_OPERATION_SCHEMA = z.enum([
  'describe',
  'execute',
  'submit',
  'poll',
  'retrieve',
  'test',
]);
type ScriptOperation = z.infer<typeof SCRIPT_OPERATION_SCHEMA>;

const SCRIPT_RESPONSE_SCHEMA = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string().min(1) }),
]);

const SCRIPT_DESCRIBE_SCHEMA = z.object({
  id: z.string().optional(),
  displayName: z.string().min(1),
  tier: PROVIDER_TIER_SCHEMA,
  envVar: z.string().optional(),
  requiresApiKey: z.boolean().optional(),
  capabilities: z
    .object({
      execute: z.boolean().optional(),
      submit: z.boolean().optional(),
      poll: z.boolean().optional(),
      retrieve: z.boolean().optional(),
      test: z.boolean().optional(),
    })
    .optional(),
});

const SCRIPT_TEST_SCHEMA = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});

const SCRIPT_PROTOCOL_VERSION = 1;
const DEFAULT_SCRIPT_OPERATION_TIMEOUT_SECONDS = 30;
const DEFAULT_SCRIPT_RETRIEVE_TIMEOUT_SECONDS = 120;

interface ScriptRequestEnvelope {
  protocolVersion: number;
  operation: ScriptOperation;
  providerId: string;
  query?: string;
  handle?: AsyncTaskHandle;
  options?: ProviderOptions;
  providerConfig?: ProviderConfig;
  sourceOptions?: Record<string, unknown>;
}

interface CustomProviderLoadOptions {
  customProviders: Config['customProviders'];
  trustedProviderIds: Config['trustedProviderIds'];
  providerConfigs: Config['providers'];
  reservedProviderIds: ReadonlySet<string>;
}

export interface CustomProviderLoadResult {
  providers: Provider[];
  loadedIds: string[];
  skippedIds: string[];
  warnings: string[];
}

export async function loadCustomProviders(
  options: CustomProviderLoadOptions,
): Promise<CustomProviderLoadResult> {
  const providers: Provider[] = [];
  const loadedIds: string[] = [];
  const skippedIds: string[] = [];
  const warnings: string[] = [];
  const trusted = new Set(options.trustedProviderIds);
  const installMethod = getInstallMethod();
  const npmLoadingBlocked =
    installMethod === 'homebrew' || installMethod === 'sea-standalone';

  for (const [providerId, source] of Object.entries(options.customProviders)) {
    if (options.reservedProviderIds.has(providerId)) {
      warnings.push(
        `Custom provider "${providerId}" conflicts with a built-in provider ID and was skipped`,
      );
      skippedIds.push(providerId);
      continue;
    }

    if (!trusted.has(providerId)) {
      warnings.push(
        `Custom provider "${providerId}" is not trusted (add it to trustedProviderIds to enable loading)`,
      );
      skippedIds.push(providerId);
      continue;
    }

    try {
      if (source.type === 'npm') {
        if (npmLoadingBlocked) {
          warnings.push(
            `Custom npm provider "${providerId}" was skipped because npm plugin loading is not supported for install method "${installMethod}"`,
          );
          skippedIds.push(providerId);
          continue;
        }
        const provider = await loadNpmProvider(
          providerId,
          source,
          options.providerConfigs[providerId],
        );
        providers.push(provider);
        loadedIds.push(providerId);
        continue;
      }

      const provider = await loadScriptProvider(
        providerId,
        source,
        options.providerConfigs[providerId],
      );
      providers.push(provider);
      loadedIds.push(providerId);
    } catch (error) {
      warnings.push(
        `Failed to load custom provider "${providerId}": ${error instanceof Error ? error.message : String(error)}`,
      );
      skippedIds.push(providerId);
    }
  }

  return { providers, loadedIds, skippedIds, warnings };
}

function getInstallMethod():
  | 'homebrew'
  | 'sea-standalone'
  | 'pnpm'
  | 'yarn'
  | 'npm' {
  try {
    return detectInstallMethod();
  } catch {
    return 'npm';
  }
}

async function loadNpmProvider(
  providerId: string,
  source: NpmProviderSource,
  providerConfig?: ProviderConfig,
): Promise<Provider> {
  const resolvedModule = resolveNpmModule(source.module);
  const imported = await import(pathToFileURL(resolvedModule).href);
  const exported = pickNpmExport(imported, source);
  const maybeProvider =
    typeof exported === 'function'
      ? await Promise.resolve(
          exported({
            id: providerId,
            config: providerConfig,
            sourceOptions: source.options ?? {},
          }),
        )
      : exported;
  return normalizeAndValidateProvider(maybeProvider, providerId, 'npm');
}

function resolveNpmModule(moduleSpecifier: string): string {
  const resolutionErrors: string[] = [];

  const projectRequire = createRequire(
    resolvePath(process.cwd(), 'package.json'),
  );
  try {
    return projectRequire.resolve(moduleSpecifier);
  } catch (error) {
    resolutionErrors.push(
      `project: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const runtimeRequire = createRequire(import.meta.url);
  try {
    return runtimeRequire.resolve(moduleSpecifier);
  } catch (error) {
    resolutionErrors.push(
      `runtime: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  throw new Error(
    `Cannot resolve npm module "${moduleSpecifier}". ${resolutionErrors.join(' | ')}`,
  );
}

function pickNpmExport(
  imported: Record<string, unknown>,
  source: NpmProviderSource,
): unknown {
  if (source.export) {
    if (source.export === 'default') {
      return imported.default;
    }
    return imported[source.export];
  }
  return imported.default ?? imported;
}

async function loadScriptProvider(
  providerId: string,
  source: ScriptProviderSource,
  providerConfig?: ProviderConfig,
): Promise<Provider> {
  const describe = await callScriptOperation({
    providerId,
    source,
    providerConfig,
    operation: 'describe',
    timeoutSeconds: DEFAULT_SCRIPT_OPERATION_TIMEOUT_SECONDS,
    schema: SCRIPT_DESCRIBE_SCHEMA,
  });

  if (describe.id && describe.id !== providerId) {
    throw new Error(
      `Script describe id "${describe.id}" does not match config key "${providerId}"`,
    );
  }

  const capabilities = describe.capabilities ?? {};
  if (capabilities.execute === false) {
    throw new Error(
      'Script provider describe.capabilities.execute must be true',
    );
  }

  const provider: Provider = {
    id: providerId,
    displayName: describe.displayName,
    tier: describe.tier,
    envVar: describe.envVar ?? '',
    source: 'script',
    requiresApiKey: describe.requiresApiKey ?? true,
    execute: async (query, options) =>
      callScriptOperation({
        providerId,
        source,
        providerConfig,
        operation: 'execute',
        query,
        options,
        timeoutSeconds: getOperationTimeoutSeconds('execute', options),
        schema: PROVIDER_RESULT_SCHEMA,
      }),
  };

  if (capabilities.submit) {
    provider.submit = async (query, options) =>
      callScriptOperation({
        providerId,
        source,
        providerConfig,
        operation: 'submit',
        query,
        options,
        timeoutSeconds: getOperationTimeoutSeconds('submit', options),
        schema: ASYNC_TASK_HANDLE_SCHEMA,
      });
  }

  if (capabilities.poll) {
    provider.poll = async (handle) =>
      callScriptOperation({
        providerId,
        source,
        providerConfig,
        operation: 'poll',
        handle,
        timeoutSeconds: getOperationTimeoutSeconds('poll'),
        schema: ASYNC_POLL_RESULT_SCHEMA,
      });
  }

  if (capabilities.retrieve) {
    provider.retrieve = async (handle) =>
      callScriptOperation({
        providerId,
        source,
        providerConfig,
        operation: 'retrieve',
        handle,
        timeoutSeconds: getOperationTimeoutSeconds('retrieve'),
        schema: PROVIDER_RESULT_SCHEMA,
      });
  }

  if (capabilities.test) {
    provider.test = async () =>
      callScriptOperation({
        providerId,
        source,
        providerConfig,
        operation: 'test',
        timeoutSeconds: getOperationTimeoutSeconds('test'),
        schema: SCRIPT_TEST_SCHEMA,
      });
  }

  return provider;
}

function getOperationTimeoutSeconds(
  operation: ScriptOperation,
  options?: ProviderOptions,
): number {
  if (operation === 'execute' || operation === 'submit') {
    return Math.max(1, Math.floor(options?.timeout ?? 1));
  }
  if (operation === 'retrieve') {
    return DEFAULT_SCRIPT_RETRIEVE_TIMEOUT_SECONDS;
  }
  return DEFAULT_SCRIPT_OPERATION_TIMEOUT_SECONDS;
}

async function callScriptOperation<T>({
  providerId,
  source,
  providerConfig,
  operation,
  query,
  handle,
  options,
  timeoutSeconds,
  schema,
}: {
  providerId: string;
  source: ScriptProviderSource;
  providerConfig?: ProviderConfig;
  operation: ScriptOperation;
  query?: string;
  handle?: AsyncTaskHandle;
  options?: ProviderOptions;
  timeoutSeconds: number;
  schema: z.ZodSchema<T>;
}): Promise<T> {
  const envelope: ScriptRequestEnvelope = {
    protocolVersion: SCRIPT_PROTOCOL_VERSION,
    operation,
    providerId,
    query,
    handle,
    options,
    providerConfig,
    sourceOptions: source.options ?? {},
  };

  const raw = await runScriptOperation(source, envelope, timeoutSeconds);
  const response = SCRIPT_RESPONSE_SCHEMA.parse(raw);

  if (!response.ok) {
    throw new Error(
      `Script provider operation "${operation}" failed: ${response.error}`,
    );
  }

  try {
    return schema.parse(response.data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issue = error.issues[0];
      throw new Error(
        `Script provider returned invalid "${operation}" payload: ${issue?.message ?? error.message}`,
      );
    }
    throw error;
  }
}

function runScriptOperation(
  source: ScriptProviderSource,
  envelope: ScriptRequestEnvelope,
  timeoutSeconds: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(source.command, source.args ?? [], {
      cwd: source.cwd ? resolvePath(process.cwd(), source.cwd) : process.cwd(),
      env: { ...process.env, ...(source.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      finish(
        new Error(
          `Failed to start script provider command "${source.command}": ${error.message}`,
        ),
      );
    });

    child.on('close', (code, signal) => {
      const trimmed = stdout.trim();
      if (!trimmed) {
        const detail = [
          code !== null ? `exit code ${code}` : null,
          signal ? `signal ${signal}` : null,
          stderr.trim() ? `stderr: ${stderr.trim().slice(0, 300)}` : null,
        ]
          .filter(Boolean)
          .join(', ');
        finish(
          new Error(
            `Script provider returned no JSON response for operation "${envelope.operation}"${detail ? ` (${detail})` : ''}`,
          ),
        );
        return;
      }

      try {
        const parsed = JSON.parse(trimmed) as unknown;
        finish(undefined, parsed);
      } catch (error) {
        const detail = stderr.trim()
          ? ` stderr: ${stderr.trim().slice(0, 300)}`
          : '';
        finish(
          new Error(
            `Script provider returned invalid JSON for operation "${envelope.operation}": ${error instanceof Error ? error.message : String(error)}.${detail}`,
          ),
        );
      }
    });

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(
        new Error(
          `Script provider operation "${envelope.operation}" timed out after ${timeoutSeconds}s`,
        ),
      );
    }, Math.max(1, timeoutSeconds) * 1000);

    child.stdin.write(JSON.stringify(envelope));
    child.stdin.end();
  });
}

function normalizeAndValidateProvider(
  candidate: unknown,
  providerId: string,
  source: 'npm' | 'script',
): Provider {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('Provider module did not return a provider object');
  }

  const provider = candidate as Partial<Provider>;

  if (provider.id !== providerId) {
    throw new Error(
      `Provider id mismatch: expected "${providerId}", got "${provider.id ?? 'undefined'}"`,
    );
  }
  if (!provider.displayName || typeof provider.displayName !== 'string') {
    throw new Error('Provider must define a non-empty displayName');
  }
  if (!provider.tier || !isProviderTier(provider.tier)) {
    throw new Error(`Provider must define a valid tier`);
  }
  if (typeof provider.envVar !== 'string') {
    throw new Error('Provider must define envVar as a string');
  }
  if (typeof provider.execute !== 'function') {
    throw new Error('Provider must define an execute(query, options) function');
  }
  for (const method of ['submit', 'poll', 'retrieve', 'test'] as const) {
    const value = provider[method];
    if (value !== undefined && typeof value !== 'function') {
      throw new Error(`Provider method "${method}" must be a function`);
    }
  }

  provider.source = source;
  provider.requiresApiKey ??= true;
  if (provider.requiresApiKey && provider.envVar.trim().length === 0) {
    throw new Error(
      'Provider requires an API key but envVar is empty; set requiresApiKey=false for keyless providers',
    );
  }

  return provider as Provider;
}

function isProviderTier(value: unknown): value is ProviderTier {
  return (
    value === 'deep-research' ||
    value === 'ai-grounded' ||
    value === 'raw-search'
  );
}
