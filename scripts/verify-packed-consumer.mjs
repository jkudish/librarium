#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  copyFileSync,
  writeFileSync,
} from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { build as esbuild } from 'esbuild';
import { resolveNativeTypeScript7Compiler } from './typescript-toolchain.mjs';

const expectEngineRejection = process.argv.includes(
  '--expect-engine-rejection',
);
function option(name) {
  const flag = `--${name}`;
  const indexes = process.argv.flatMap((value, index) =>
    value === flag ? [index] : [],
  );
  if (indexes.length > 1) throw new Error(`Duplicate option: ${flag}`);
  const index = indexes[0];
  if (index === undefined) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

const suppliedTarball = option('tarball');
const suppliedSha256 = option('sha256');
if ((suppliedTarball === undefined) !== (suppliedSha256 === undefined)) {
  throw new Error('--tarball and --sha256 must be supplied together');
}
if (suppliedSha256 && !/^[0-9a-f]{64}$/.test(suppliedSha256)) {
  throw new Error('--sha256 must be exactly 64 lowercase hexadecimal characters');
}
const root = process.cwd();
const workspace = mkdtempSync(join(tmpdir(), 'librarium-packed-consumer-'));
const packDirectory = join(workspace, 'pack');
const consumerDirectory = join(workspace, 'consumer');
const npmEnvironment = process.env;
const NODE_BUILTINS = new Set(
  builtinModules.flatMap((specifier) => [
    specifier,
    specifier.startsWith('node:') ? specifier.slice(5) : `node:${specifier}`,
  ]),
);

const ROOT_EXPORTS = [
  'BUILTIN_PROVIDER_CATALOG',
  'CitationSchema',
  'ConfigProviderV2Schema',
  'CustomProviderExecutionProfileV2Schema',
  'CustomProviderSourceV2Schema',
  'ExecutionDefaultsV2Schema',
  'JsonValueSchema',
  'LibrariumConfigV2Schema',
  'LibrariumProjectConfigV2Schema',
  'NpmCustomProviderSourceV2Schema',
  'ResearchErrorSchema',
  'ResearchRequestSchema',
  'ResearchResponseSchema',
  'ResearchResultSchema',
  'ResultProvenanceSchema',
  'RuntimeConfigV2Schema',
  'ScriptCustomProviderSourceV2Schema',
  'SourceSchema',
  'UsageSchema',
  'VERSION',
  'migrateConfig',
  'validateConfigV2',
].sort();

const CORE_EXPORTS = [
  ...ROOT_EXPORTS,
  'HttpRequestAbortedError',
  'HttpRequestTimeoutError',
  'HttpResponseTooLargeError',
  'InMemoryCoordinationStateStore',
  'ProviderCatalogError',
  'admitResearchExecution',
  'buildPrompt',
  'buildProviderCatalog',
  'createProviderAttemptBridge',
  'generateSlug',
  'httpRequest',
  'httpStreamRequest',
  'materializeResearchExecution',
  'prepareResearchExecution',
  'resolveOutputDir',
  'runPreparedExecution',
  'updateCoordinationState',
].sort();

const NODE_EXPORTS = [
  ...CORE_EXPORTS,
  'CanonicalLiveValidationError',
  'CanonicalValidationCheckpointRepository',
  'ConfigV2FileError',
  'approvalFingerprint',
  'assertCanonicalTargetDispatchable',
  'assertCanonicalValidationPins',
  'assertCanonicalValidationPreparedExecution',
  'assertLiveValidationGate',
  'buildCanonicalValidationMatrix',
  'continueFrozenValidationProtocol',
  'createCanonicalPreparedValidationExecutor',
  'createFilesystemCandidateAuthority',
  'createNodeCredentialContext',
  'deterministicReceiptSensibility',
  'executeCanonicalValidationLane',
  'executeFrozenValidationProtocol',
  'executeWithCanonicalValidationAbort',
  'interruptCanonicalValidation',
  'loadCustomProviders',
  'loadConfigV2',
  'materializeCanonicalPreparedExecution',
  'productionLiveValidationBindingUnavailable',
  'projectConfigV2Path',
  'quoteCanonicalValidationTarget',
  'readLiveValidationApproval',
  'readPrivateRawEvidence',
  'sanitizeCanonicalReceipt',
  'saveConfigV2',
  'writePrivateRawEvidence',
  'writeSanitizedCanonicalReceipt',
].sort();

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runNode(args, cwd = consumerDirectory, environment = process.env) {
  return execFileSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function runInstalledCli(args) {
  const executable = join(
    consumerDirectory,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'librarium.cmd' : 'librarium',
  );

  if (process.platform === 'win32') {
    const command = [
      '"',
      executable.replaceAll('"', '""'),
      '" ',
      args.join(' '),
    ].join('');
    return execFileSync(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', command],
      {
        cwd: consumerDirectory,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();
  }

  return execFileSync(executable, args, {
    cwd: consumerDirectory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function listFiles(directory, base = directory) {
  const files = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...listFiles(path, base));
    else files.push(relative(base, path).split(sep).join('/'));
  }
  return files.sort();
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label} mismatch:\nexpected ${JSON.stringify(expected)}\nreceived ${JSON.stringify(actual)}`,
    );
  }
}

function verifyTarballInventory(packResult) {
  const actual = packResult.files.map(({ path }) => path).sort();
  const expected = [
    'LICENSE',
    'README.md',
    'package.json',
    ...listFiles(join(root, 'dist')).map((path) => `dist/${path}`),
  ].sort();
  assertEqual(actual, expected, 'Packed tarball inventory');

  for (const forbidden of [
    'dist/cli.d.ts',
    'dist/cli.d.ts.map',
    'contracts/v1',
  ]) {
    if (
      actual.some(
        (path) => path === forbidden || path.startsWith(`${forbidden}/`),
      )
    ) {
      throw new Error(`Forbidden packed artifact: ${forbidden}`);
    }
  }
}

function verifyExports() {
  const source = `
    const checks = ${JSON.stringify({
      librarium: ROOT_EXPORTS,
      'librarium/core': CORE_EXPORTS,
      'librarium/node': NODE_EXPORTS,
    })};
    for (const [specifier, expected] of Object.entries(checks)) {
      const actual = Object.keys(await import(specifier)).sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(specifier + ' exports ' + JSON.stringify(actual));
      }
    }
    for (const specifier of [
      'librarium/cli',
      'librarium/contracts/v1',
      'librarium/package.json',
      'librarium/adapters',
      'librarium/internal',
    ]) {
      try {
        await import(specifier);
        throw new Error('Unexpected public subpath: ' + specifier);
      } catch (error) {
        if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
      }
    }
  `;
  runNode(['--input-type=module', '--eval', source]);
}

function verifyImportSideEffects() {
  const home = join(workspace, 'poisoned-home');
  // Keep the poisoned cwd below the consumer so bare package resolution still
  // reaches the installed tarball while filesystem effects remain isolated.
  const cwd = join(consumerDirectory, 'poisoned-cwd');
  mkdirSync(home);
  mkdirSync(cwd);
  const source = `
    import { readdirSync } from 'node:fs';
    const before = JSON.stringify(readdirSync('.').sort());
    const exitCodeBefore = process.exitCode;
    process.argv = [process.execPath, 'librarium', 'config', 'init'];
    process.exit = (code) => { throw new Error('process.exit:' + code); };
    process.stdout.write = () => { throw new Error('stdout write'); };
    process.stderr.write = () => { throw new Error('stderr write'); };
    for (const method of ['on', 'once', 'addListener', 'prependListener']) {
      const original = process[method].bind(process);
      process[method] = (event, ...args) => {
        if (String(event).startsWith('SIG')) throw new Error('signal listener:' + event);
        return original(event, ...args);
      };
    }
    await import('librarium');
    await import('librarium/core');
    await import('librarium/node');
    if (process.exitCode !== exitCodeBefore) {
      throw new Error('import changed process.exitCode');
    }
    const after = JSON.stringify(readdirSync('.').sort());
    if (before !== after) throw new Error('import wrote files');
  `;
  runNode(['--input-type=module', '--eval', source], cwd, {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
  });
  if (readdirSync(home).length !== 0 || readdirSync(cwd).length !== 0) {
    throw new Error('Root/core/node import changed the filesystem');
  }
}

function verifyDeclarations(installedPackageRoot) {
  const compilers = [
    {
      label: 'TypeScript 7',
      command: resolveNativeTypeScript7Compiler(root),
      args: (configPath) => ['--project', configPath],
    },
    {
      label: 'TypeScript 6 compatibility',
      command: process.execPath,
      path: resolve(root, 'node_modules/@typescript/typescript6/bin/tsc6'),
      args: (configPath) => ['--project', configPath],
    },
  ];
  const typecheck = (configPath) => {
    for (const compiler of compilers) {
      const args = compiler.path
        ? [compiler.path, ...compiler.args(configPath)]
        : compiler.args(configPath);
      execFileSync(compiler.command, args, {
        cwd: consumerDirectory,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
  };
  const workerSourcePath = join(consumerDirectory, 'worker-consumer.ts');
  const workerConfigPath = join(consumerDirectory, 'worker-tsconfig.json');
  copyFileSync(
    join(root, 'tests/fixtures/declarations/worker-public-api.ts'),
    join(consumerDirectory, 'worker-public-api.ts'),
  );
  writeFileSync(
    workerSourcePath,
    `
      import {
        BUILTIN_PROVIDER_CATALOG,
        type BuiltinWorkflowId,
        type DeclarableWorkflowId,
        type ExecutionProfile,
        type LibrariumConfigV2,
        LibrariumConfigV2Schema,
        migrateConfig,
        type ProfileTarget,
        type ProviderIdentity,
        ResearchRequestSchema,
        type ResearchRequest,
        validateConfigV2,
      } from 'librarium';
      import {
        type AsyncPollResult,
        type AsyncTaskHandle,
        type AttemptLaunch,
        buildProviderCatalog,
        type CatalogProviderConfig,
        type CoordinatorDependencies,
        type CoordinatorState,
        type DurableHandle,
        type InterchangeRequest,
        type LegacyProviderTier,
        type PreparationNotice,
        type ProviderCitation,
        type StructuredError,
        type AttemptExecutionPort,
        type HttpClient,
      } from 'librarium/core';
      declare const launch: AttemptLaunch;
      declare const error: StructuredError;
      declare const handle: DurableHandle;
      declare const coordinator: CoordinatorDependencies;
      declare const state: CoordinatorState;
      declare const preparedRequest: InterchangeRequest;
      declare const notice: PreparationNotice;
      declare const task: AsyncTaskHandle;
      declare const poll: AsyncPollResult;
      declare const tier: LegacyProviderTier;
      declare const providerCitation: ProviderCitation;
      declare const identity: ProviderIdentity;
      declare const target: ProfileTarget;
      declare const workflow: BuiltinWorkflowId;
      declare const declaredWorkflow: DeclarableWorkflowId;
      const catalogConfig: CatalogProviderConfig = {
        enabled: true,
        model: 'fixture-model',
      };
      const request: ResearchRequest = ResearchRequestSchema.parse({
        query: 'packed declaration consumer',
        mode: 'sync',
        selector: { kind: 'default' },
        fallback: { kind: 'disabled' },
        limits: {
          max_concurrency: 1,
          request_deadline_ms: 1000,
          inline_attempt_deadline_ms: 1000,
          background_attempt_deadline_ms: 1000,
          poll_interval_ms: 100,
        },
      });
      const config: LibrariumConfigV2 = LibrariumConfigV2Schema.parse({
        version: 2,
        execution_defaults: {
          mode: 'sync',
          max_concurrency: 1,
          inline_attempt_deadline_ms: 1000,
          background_attempt_deadline_ms: 1000,
          poll_interval_ms: 100,
        },
        providers: {},
        custom_providers: {},
        trusted_provider_ids: [],
        groups: {},
        runtime: { output_dir: './runs', llm_web_search: true },
      });
      const validatedConfig = validateConfigV2(config);
      const migratedConfig = migrateConfig({ global: config });
      const client: HttpClient = async <T>() => ({
        status: 200,
        statusText: 'OK',
        headers: {},
        data: {} as T,
        durationMs: 1,
      });
      const port: AttemptExecutionPort = {
        async execute(received, context) {
          const typedLaunch: AttemptLaunch = received;
          const profile: ExecutionProfile = typedLaunch.profile;
          await context.submissionAccepted(handle);
          return {
            kind: 'finished',
            finished: {
              outcome: 'failed',
              error,
              durable_handle: handle,
            },
          };
        },
      };
      void [
        BUILTIN_PROVIDER_CATALOG,
        buildProviderCatalog,
        request,
        validatedConfig,
        migratedConfig,
        client,
        port,
        launch,
        coordinator,
        state,
        preparedRequest,
        notice,
        task,
        poll,
        tier,
        providerCitation,
        identity,
        target,
        workflow,
        declaredWorkflow,
        catalogConfig,
      ];
    `,
  );
  writeFileSync(
    workerConfigPath,
    JSON.stringify({
      compilerOptions: {
        target: 'ES2023',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: [],
        lib: ['ES2023', 'DOM', 'DOM.Iterable'],
      },
      files: ['./worker-consumer.ts', './worker-public-api.ts'],
    }),
  );
  typecheck(workerConfigPath);

  const nodeSourcePath = join(consumerDirectory, 'node-consumer.ts');
  const nodeConfigPath = join(consumerDirectory, 'node-tsconfig.json');
  copyFileSync(
    join(root, 'tests/fixtures/declarations/node-public-api.ts'),
    join(consumerDirectory, 'node-public-api.ts'),
  );
  writeFileSync(
    nodeSourcePath,
    `
      import {
        type CustomProviderExecutionProfileConfig,
        type CustomProviderLoadConfig,
        type CustomProviderLoadResult,
        type CustomProviderRuntimeConfig,
        type ExecutionProfile,
        type LoadCustomProvidersOptions,
        type NpmCustomProviderSource,
        type ScriptCustomProviderSource,
        createNodeCredentialContext,
        type LibrariumConfigV2,
        loadConfigV2,
        loadCustomProviders,
        projectConfigV2Path,
        saveConfigV2,
      } from 'librarium/node';
      declare const profile: ExecutionProfile;
      const credentials = createNodeCredentialContext({ TEST_KEY: 'value' });
      const executionProfile: CustomProviderExecutionProfileConfig = {
        bindingId: 'fixture.binding',
        profile,
      };
      const npmSource: NpmCustomProviderSource = {
        type: 'npm',
        module: 'fixture-provider',
        executionProfile,
      };
      const scriptSource: ScriptCustomProviderSource = {
        type: 'script',
        command: 'fixture-provider',
      };
      const provider: CustomProviderRuntimeConfig = { enabled: true };
      const config: CustomProviderLoadConfig = {
        customProviders: { npmSource, scriptSource },
        trustedProviderIds: ['npmSource', 'scriptSource'],
        providers: { npmSource: provider, scriptSource: provider },
      };
      const options: LoadCustomProvidersOptions = { reservedProviderIds: [] };
      const loaded: Promise<CustomProviderLoadResult> = loadCustomProviders(
        config,
        options,
      );
      declare const v2Config: LibrariumConfigV2;
      const migrated = loadConfigV2({ global_path: './config.json' });
      saveConfigV2(v2Config, { path: './saved-config.json' });
      const projectPath: string = projectConfigV2Path('.');
      void credentials;
      void loaded;
      void migrated;
      void projectPath;
    `,
  );
  writeFileSync(
    nodeConfigPath,
    JSON.stringify({
      compilerOptions: {
        target: 'ES2023',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: ['node'],
        typeRoots: [resolve(root, 'node_modules/@types')],
        lib: ['ES2023', 'DOM', 'DOM.Iterable'],
      },
      files: ['./node-consumer.ts', './node-public-api.ts'],
    }),
  );
  typecheck(nodeConfigPath);

  const nodeDeclaration = readFileSync(
    join(installedPackageRoot, 'dist/node-entry.d.ts'),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  if (/\bConfig\b/.test(nodeDeclaration)) {
    throw new Error('The public Node declaration leaks the legacy Config type');
  }
}

async function verifyWorkerSafeGraph(installedPackageRoot) {
  const scan = await esbuild({
    entryPoints: [join(root, 'src/index.ts'), join(root, 'src/core-entry.ts')],
    outdir: join(workspace, 'worker-scan'),
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2023',
    packages: 'external',
    write: false,
    metafile: true,
    define: { __VERSION__: JSON.stringify('packed-verifier') },
  });
  const inputs = Object.keys(scan.metafile.inputs).map((path) =>
    path.split(sep).join('/'),
  );
  const forbiddenSources = [
    'src/adapters/custom.ts',
    'src/commands/',
    'src/mcp/',
    'src/node-',
    'src/cli',
    'src/core/config.ts',
    'src/core/install-method.ts',
  ];
  for (const input of inputs) {
    if (forbiddenSources.some((fragment) => input.includes(fragment))) {
      throw new Error(`Worker-safe graph reached ${input}`);
    }
  }
  for (const [output, metadata] of Object.entries(scan.metafile.outputs)) {
    for (const imported of metadata.imports) {
      if (imported.external && NODE_BUILTINS.has(imported.path)) {
        throw new Error(`${output} imports Node builtin ${imported.path}`);
      }
    }
  }

  const distEntries = [
    join(installedPackageRoot, 'dist/index.js'),
    join(installedPackageRoot, 'dist/core.js'),
  ];
  const visited = new Set();
  const visit = (path) => {
    if (visited.has(path)) return;
    visited.add(path);
    const source = readFileSync(path, 'utf8');
    const specifiers = [
      ...source.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g),
      ...source.matchAll(/(?:import|require)\s*\(\s*["']([^"']+)["']/g),
    ].map((match) => match[1]);
    for (const specifier of specifiers) {
      if (NODE_BUILTINS.has(specifier)) {
        throw new Error(
          `Worker-safe output imports Node builtin ${specifier}: ${path}`,
        );
      }
      if (specifier.startsWith('./')) {
        visit(resolve(dirname(path), specifier));
      }
    }
  };
  for (const entry of distEntries) visit(entry);
}

try {
  mkdirSync(packDirectory);
  mkdirSync(consumerDirectory);

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (pkg.engines?.node !== '>=22.12.0') {
    throw new Error(
      `Expected package engines.node to be >=22.12.0, received ${String(pkg.engines?.node)}`,
    );
  }
  let tarball;
  if (suppliedTarball) {
    tarball = resolve(suppliedTarball);
    const actualSha256 = createHash('sha256')
      .update(readFileSync(tarball))
      .digest('hex');
    if (actualSha256 !== suppliedSha256) {
      throw new Error(
        `Supplied tarball SHA-256 mismatch: expected ${suppliedSha256}, received ${actualSha256}`,
      );
    }
  } else {
    const packOutput = execFileSync(
      npmCommand(),
      ['pack', '--json', '--pack-destination', packDirectory],
      {
        cwd: root,
        encoding: 'utf8',
        env: npmEnvironment,
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    const [packResult] = JSON.parse(packOutput);
    if (!packResult) throw new Error('npm pack did not return a package result');
    verifyTarballInventory(packResult);
    tarball = resolve(packDirectory, packResult.filename);
  }

  execFileSync(npmCommand(), ['init', '--yes'], {
    cwd: consumerDirectory,
    env: npmEnvironment,
    stdio: 'ignore',
  });

  const install = spawnSync(
    npmCommand(),
    [
      'install',
      '--engine-strict',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--prefer-offline',
      tarball,
    ],
    {
      cwd: consumerDirectory,
      encoding: 'utf8',
      env: { ...npmEnvironment, npm_config_engine_strict: 'true' },
    },
  );

  if (expectEngineRejection) {
    if (install.status === 0) {
      throw new Error(
        `Expected Node ${process.version} to reject ${pkg.name} ${pkg.engines.node}`,
      );
    }

    const diagnostics = `${install.stdout ?? ''}\n${install.stderr ?? ''}`;
    if (!/EBADENGINE|Unsupported engine/i.test(diagnostics)) {
      throw new Error(
        `Expected an engine-strict rejection, received:\n${diagnostics.trim()}`,
      );
    }
    if (
      !diagnostics.includes(`${pkg.name}@${pkg.version}`) ||
      !diagnostics.includes(pkg.engines.node)
    ) {
      throw new Error(
        `Engine rejection did not identify ${pkg.name}@${pkg.version} ${pkg.engines.node}:\n${diagnostics.trim()}`,
      );
    }

    console.log(
      `Verified Node ${process.version} rejects ${pkg.name} ${pkg.engines.node}`,
    );
  } else {
    if (install.status !== 0) {
      throw new Error(
        `Packed consumer install failed:\n${install.stdout ?? ''}\n${install.stderr ?? ''}`,
      );
    }

    const installedPackageRoot = join(
      consumerDirectory,
      'node_modules',
      'librarium',
    );
    await verifyWorkerSafeGraph(installedPackageRoot);
    verifyExports();
    verifyImportSideEffects();
    verifyDeclarations(installedPackageRoot);
    runNode([
      '--input-type=module',
      '--eval',
      "await import('librarium'); await import('librarium/core'); await import('librarium/node');",
    ]);

    runInstalledCli(['--help']);
    const version = runInstalledCli(['--version']);
    if (version !== pkg.version) {
      throw new Error(
        `Expected CLI version ${pkg.version}, received ${version}`,
      );
    }

    console.log(
      `Verified packed ${pkg.name}@${pkg.version} on ${process.version}: inventory, exports, declarations, Worker-safe graph, side effects, CLI`,
    );
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
