import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  copyFixtureRun,
  findRunDirectory,
  loadFixturePack,
  parseLibrariumRun,
  resolveArtifactReference,
} from './artifacts.mjs';
import {
  assertLiveQuestionsFresh,
  benchmarkRoot,
  loadCorpus,
  selectQuestions,
} from './corpus.mjs';
import { assertOfflineCi } from './guard.mjs';
import {
  fingerprint,
  readJson,
  safeSegment,
  timestampForPath,
  writeJson,
  writeJsonAtomic,
} from './io.mjs';
import { fixtureGrade, gradeAnswer, synthesizeAnswer } from './judge.mjs';
import { buildSummary, renderMarkdownReport } from './report.mjs';
import { scoreCase } from './scoring.mjs';
import {
  allTargets,
  buildPreflight,
  loadTargetCatalog,
  selectTargets,
} from './targets.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, '..', '..');

function gitRevision() {
  try {
    const gitEnvironment = {
      PATH: process.env.PATH,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    };
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot,
      env: gitEnvironment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function optionalJson(path) {
  return existsSync(path) ? readJson(path) : {};
}

function resolvedProviderConfiguration(targets, catalog) {
  const globalConfig = optionalJson(
    join(homedir(), '.config', 'librarium', 'config.json'),
  );
  const projectConfig = optionalJson(join(repositoryRoot, '.librarium.json'));
  const selected = new Set(targets.flatMap((target) => target.members));
  const providers = catalog.providers
    .filter((provider) => selected.has(provider.id))
    .map((provider) => {
      const globalProvider = globalConfig.providers?.[provider.id] ?? {};
      const projectProvider = projectConfig.providers?.[provider.id] ?? {};
      const model = projectProvider.model ?? globalProvider.model ?? null;
      const credentialReference =
        projectProvider.apiKey ??
        globalProvider.apiKey ??
        `$${provider.envVar}`;
      const credentialEnvironmentVariable = credentialReference.startsWith('$')
        ? credentialReference.slice(1).trim() || null
        : null;
      return {
        id: provider.id,
        tier: provider.tier,
        model,
        modelSource: model ? 'configured' : 'provider-response-after-call',
        credentialEnvironmentVariable,
        credentialSource: credentialEnvironmentVariable
          ? 'environment'
          : credentialReference.startsWith('keychain:')
            ? 'keychain'
            : 'config-literal',
      };
    });
  const globalDefaults = globalConfig.defaults ?? {};
  const projectDefaults = projectConfig.defaults ?? {};
  return {
    providers,
    asyncTimeoutSeconds:
      projectDefaults.asyncTimeout ?? globalDefaults.asyncTimeout ?? 1800,
  };
}

const runtimeEnvironmentVariables = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'TZ',
];

export function buildLiveChildEnvironment(env, credentialEnvironmentVariables) {
  const childEnvironment = { NO_COLOR: '1' };
  for (const key of [
    ...runtimeEnvironmentVariables,
    ...credentialEnvironmentVariables,
  ]) {
    if (typeof env[key] === 'string' && env[key] !== '') {
      childEnvironment[key] = env[key];
    }
  }
  return childEnvironment;
}

function runLibrarium(args, childEnvironment) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repositoryRoot,
      env: childEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (exitCode, signal) => {
      resolvePromise({ exitCode, signal, stdout, stderr });
    });
  });
}

export function buildLiveCaseArguments({
  cli,
  question,
  target,
  outputBase,
  config,
}) {
  return [
    cli,
    'run',
    question.question,
    '--providers',
    target.members.join(','),
    '--mode',
    'sync',
    '--output',
    outputBase,
    '--timeout',
    String(config.execution.providerTimeoutSeconds),
    '--no-fallback',
    '--json',
    '--yes',
  ];
}

export function assertExactTargetRun(parsedRun, target) {
  const expected = [...target.members].sort();
  const actual = parsedRun.providerOutputs
    .map((output) => output.provider)
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Benchmark provider matrix mismatch for ${target.id}: expected ${expected.join(', ')}, received ${actual.join(', ') || 'none'}`,
    );
  }
}

async function executeLiveCase({
  question,
  target,
  rawDirectory,
  config,
  env,
  providerConfiguration,
}) {
  const cli = join(repositoryRoot, 'dist', 'cli.js');
  if (!existsSync(cli)) {
    throw new Error(
      'dist/cli.js is missing; run npm run build before a live benchmark',
    );
  }
  const outputBase = join(rawDirectory, 'librarium');
  mkdirSync(outputBase, { recursive: true });
  const credentialEnvironmentVariables = providerConfiguration
    .filter((provider) => target.members.includes(provider.id))
    .map((provider) => provider.credentialEnvironmentVariable)
    .filter(Boolean);
  const childEnvironment = buildLiveChildEnvironment(
    env,
    credentialEnvironmentVariables,
  );
  const result = await runLibrarium(
    buildLiveCaseArguments({ cli, question, target, outputBase, config }),
    childEnvironment,
  );
  writeFileSync(
    join(rawDirectory, 'librarium.stdout.log'),
    result.stdout,
    'utf8',
  );
  writeFileSync(
    join(rawDirectory, 'librarium.stderr.log'),
    result.stderr,
    'utf8',
  );
  let manifest;
  try {
    manifest = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `Librarium exited ${result.exitCode ?? result.signal ?? 'unknown'} without a JSON manifest`,
    );
  }
  const runDir = findRunDirectory(outputBase, manifest);
  const parsedRun = parseLibrariumRun(runDir);
  assertExactTargetRun(parsedRun, target);
  return parsedRun;
}

function fixtureSelection(fixturePack, corpus, catalog) {
  const questionIds = [
    ...new Set(fixturePack.fixture.cases.map((item) => item.questionId)),
  ];
  const targetIds = [
    ...new Set(fixturePack.fixture.cases.map((item) => item.targetId)),
  ];
  const questions = [
    ...corpus.stable.questions,
    ...corpus.live.questions,
  ].filter((question) => questionIds.includes(question.id));
  const targets = allTargets(catalog).filter((target) =>
    targetIds.includes(target.id),
  );
  if (
    questions.length !== questionIds.length ||
    targets.length !== targetIds.length
  ) {
    throw new Error(
      'Fixture pack references questions or targets missing from the catalogs',
    );
  }
  for (const question of questions) {
    for (const target of targets) {
      if (!fixturePack.cases.has(`${question.id}::${target.id}`)) {
        throw new Error(
          `Fixture pack must contain the full question × target matrix; missing ${question.id}::${target.id}`,
        );
      }
    }
  }
  return { questions, targets };
}

function resolveNewRun(options, dependencies) {
  const corpus = dependencies.corpus ?? loadCorpus();
  const catalog = dependencies.catalog ?? loadTargetCatalog();
  const config =
    dependencies.config ?? readJson(join(benchmarkRoot, 'config.json'));
  const fixturePack = options.fixture ? loadFixturePack(options.fixture) : null;
  let questions;
  let targets;
  const hasExplicitSelection =
    (options.questionIds?.length ?? 0) > 0 ||
    (options.providers?.length ?? 0) > 0 ||
    (options.groups?.length ?? 0) > 0 ||
    (options.candidates?.length ?? 0) > 0;
  if (fixturePack && !hasExplicitSelection) {
    ({ questions, targets } = fixtureSelection(fixturePack, corpus, catalog));
  } else {
    questions = selectQuestions(
      corpus,
      options.track ?? 'stable',
      options.questionIds,
    );
    targets = selectTargets(catalog, {
      providers: options.providers,
      groups: options.groups,
      candidates: options.candidates,
    });
  }
  if (!fixturePack)
    assertLiveQuestionsFresh(questions, dependencies.now?.() ?? new Date());

  const createdAt = (dependencies.now?.() ?? new Date()).toISOString();
  const runId = timestampForPath(new Date(createdAt));
  const outputRoot = resolve(options.output ?? join(benchmarkRoot, 'results'));
  const outputDirectory = join(outputRoot, runId);
  const packageJson = readJson(join(repositoryRoot, 'package.json'));
  const librariumConfiguration = resolvedProviderConfiguration(
    targets,
    catalog,
  );
  const resolvedExecution = {
    ...config.execution,
    deepResearchTimeoutSeconds: librariumConfiguration.asyncTimeoutSeconds,
  };
  const resolvedConfig = {
    schemaVersion: 1,
    artifactVersion: config.artifactVersion,
    runId,
    createdAt,
    mode: fixturePack ? 'fixture' : 'live',
    fixture: fixturePack?.manifestPath ?? null,
    track: options.track ?? 'stable',
    corpusVersion: config.corpusVersion,
    datasetVersions: {
      stable: corpus.stable.version,
      live: corpus.live.version,
    },
    targetCatalogFingerprint: fingerprint(catalog),
    questions: questions.map((question) => question.id),
    targets,
    providerConfiguration: librariumConfiguration.providers,
    synthesis: config.synthesis,
    judge: config.judge,
    execution: resolvedExecution,
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      librariumVersion: packageJson.version,
      gitRevision: gitRevision(),
    },
  };
  resolvedConfig.fingerprint = fingerprint({
    artifactVersion: resolvedConfig.artifactVersion,
    mode: resolvedConfig.mode,
    fixture: resolvedConfig.fixture,
    track: resolvedConfig.track,
    corpusVersion: resolvedConfig.corpusVersion,
    datasetVersions: resolvedConfig.datasetVersions,
    targetCatalogFingerprint: resolvedConfig.targetCatalogFingerprint,
    questions: resolvedConfig.questions,
    targets: resolvedConfig.targets,
    providerConfiguration: resolvedConfig.providerConfiguration,
    synthesis: resolvedConfig.synthesis,
    judge: resolvedConfig.judge,
    execution: resolvedConfig.execution,
  });
  return {
    corpus,
    catalog,
    config,
    fixturePack,
    questions,
    targets,
    resolvedConfig,
    outputDirectory,
  };
}

function resolveResume(options, dependencies) {
  const outputDirectory = resolve(options.resume);
  const resolvedConfig = readJson(
    resolveArtifactReference(
      outputDirectory,
      'config.json',
      'resume config.json',
    ),
  );
  const corpus = dependencies.corpus ?? loadCorpus();
  const catalog = dependencies.catalog ?? loadTargetCatalog();
  const config =
    dependencies.config ?? readJson(join(benchmarkRoot, 'config.json'));
  const questionMap = new Map(
    [...corpus.stable.questions, ...corpus.live.questions].map((question) => [
      question.id,
      question,
    ]),
  );
  const targetMap = new Map(
    allTargets(catalog).map((target) => [target.id, target]),
  );
  const questions = resolvedConfig.questions.map((id) => questionMap.get(id));
  const targets = resolvedConfig.targets.map((stored) =>
    targetMap.get(stored.id),
  );
  if (questions.some((item) => !item) || targets.some((item) => !item)) {
    throw new Error(
      'Cannot resume because the corpus or target catalog changed incompatibly',
    );
  }
  const fixturePack = resolvedConfig.fixture
    ? loadFixturePack(resolvedConfig.fixture)
    : null;
  if (!fixturePack) {
    assertLiveQuestionsFresh(questions, dependencies.now?.() ?? new Date());
  }
  const librariumConfiguration = resolvedProviderConfiguration(
    targets,
    catalog,
  );
  const resolvedExecution = {
    ...config.execution,
    deepResearchTimeoutSeconds: librariumConfiguration.asyncTimeoutSeconds,
  };
  const currentFingerprint = fingerprint({
    artifactVersion: config.artifactVersion,
    mode: resolvedConfig.mode,
    fixture: resolvedConfig.fixture,
    track: resolvedConfig.track,
    corpusVersion: config.corpusVersion,
    datasetVersions: {
      stable: corpus.stable.version,
      live: corpus.live.version,
    },
    targetCatalogFingerprint: fingerprint(catalog),
    questions: resolvedConfig.questions,
    targets: resolvedConfig.targets,
    providerConfiguration: librariumConfiguration.providers,
    synthesis: config.synthesis,
    judge: config.judge,
    execution: resolvedExecution,
  });
  if (currentFingerprint !== resolvedConfig.fingerprint) {
    throw new Error(
      'Cannot resume: resolved benchmark configuration has changed',
    );
  }
  return {
    corpus,
    catalog,
    config,
    fixturePack,
    questions,
    targets,
    resolvedConfig,
    outputDirectory,
  };
}

function initialState(run) {
  const entries = {};
  for (const question of run.questions) {
    for (const target of run.targets) {
      const key = `${question.id}::${target.id}`;
      entries[key] = {
        questionId: question.id,
        targetId: target.id,
        status: 'pending',
        attempts: 0,
        updatedAt: run.resolvedConfig.createdAt,
      };
    }
  }
  return {
    schemaVersion: 1,
    runId: run.resolvedConfig.runId,
    configFingerprint: run.resolvedConfig.fingerprint,
    entries,
  };
}

function checkpoint(path, state, key, update) {
  state.entries[key] = {
    ...state.entries[key],
    ...update,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(path, state);
}

function readRecoveredCase(outputDirectory, entry) {
  const run = parseLibrariumRun(
    resolveArtifactReference(
      outputDirectory,
      entry.rawRunDirectory,
      'resume rawRunDirectory',
    ),
  );
  const synthesis = readJson(
    resolveArtifactReference(
      outputDirectory,
      entry.synthesisFile,
      'resume synthesisFile',
    ),
  );
  return {
    run,
    synthesis,
    answer: readFileSync(
      resolveArtifactReference(
        outputDirectory,
        entry.answerFile,
        'resume answerFile',
      ),
      'utf8',
    ),
  };
}

function remainingCases(run, state) {
  const cases = [];
  for (const question of run.questions) {
    for (const target of run.targets) {
      const entry = state.entries[`${question.id}::${target.id}`];
      if (!entry || entry.status === 'scored') continue;
      cases.push({
        question,
        target,
        stage: entry.status === 'retrieved' ? 'judge' : 'full',
      });
    }
  }
  return cases;
}

function writeResults(outputDirectory, scores) {
  const sorted = [...scores].sort((a, b) =>
    `${a.questionId}::${a.target.id}`.localeCompare(
      `${b.questionId}::${b.target.id}`,
    ),
  );
  writeFileSync(
    join(outputDirectory, 'results.jsonl'),
    `${sorted.map((score) => JSON.stringify(score)).join('\n')}\n`,
    'utf8',
  );
}

export async function executeBenchmark(options = {}, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  if (!options.resume) {
    assertOfflineCi({ fixture: options.fixture, env });
  }
  const run = options.resume
    ? resolveResume(options, dependencies)
    : resolveNewRun(options, dependencies);
  assertOfflineCi({ fixture: run.fixturePack?.manifestPath, env });
  const statePath = join(run.outputDirectory, 'state.json');
  const state = options.resume
    ? readJson(
        resolveArtifactReference(
          run.outputDirectory,
          'state.json',
          'resume state.json',
        ),
      )
    : initialState(run);
  if (state.configFingerprint !== run.resolvedConfig.fingerprint) {
    throw new Error(
      'Cannot resume: benchmark state does not match the resolved configuration fingerprint',
    );
  }
  const plannedCases = remainingCases(run, state);
  const preflight = run.fixturePack
    ? {
        schemaVersion: 1,
        paidCalls: false,
        mode: 'offline-fixture',
        questionCount: new Set(
          plannedCases.map((plannedCase) => plannedCase.question.id),
        ).size,
        targetCount: new Set(
          plannedCases.map((plannedCase) => plannedCase.target.id),
        ).size,
        caseCount: plannedCases.length,
        knownEstimateUsd: 0,
        knownEstimateIsPartial: false,
        unknownCostOperations: [],
        credentials: [],
        note: 'Fixture replay performs no provider or judge network calls.',
      }
    : buildPreflight({
        questions: run.questions,
        targets: run.targets,
        catalog: run.catalog,
        config: run.config,
        env,
        cases: plannedCases,
        providerConfiguration: run.resolvedConfig.providerConfiguration,
      });

  if (options.dryRun) {
    return { dryRun: true, preflight, resolvedConfig: run.resolvedConfig };
  }

  if (!run.fixturePack) {
    const missingCredentials = [];
    if (preflight.fullCaseCount > 0 && !env[run.config.synthesis.envVar]) {
      missingCredentials.push(run.config.synthesis.envVar);
    }
    if (preflight.caseCount > 0 && !env[run.config.judge.envVar]) {
      missingCredentials.push(run.config.judge.envVar);
    }
    const uniqueMissingCredentials = [...new Set(missingCredentials)];
    if (uniqueMissingCredentials.length > 0) {
      throw new Error(
        `Pinned synthesis/judge credential${uniqueMissingCredentials.length === 1 ? '' : 's'} ${uniqueMissingCredentials.join(', ')} ${uniqueMissingCredentials.length === 1 ? 'is' : 'are'} unavailable; no substitute will be used`,
      );
    }
    const confirmed = await dependencies.confirm?.({
      resumed: Boolean(options.resume),
      resolvedConfig: run.resolvedConfig,
      remainingOperations: preflight,
    });
    if (confirmed !== true)
      throw new Error('Paid benchmark run was not confirmed');
  }

  if (!options.resume) {
    mkdirSync(run.outputDirectory, { recursive: true });
    writeJson(join(run.outputDirectory, 'config.json'), run.resolvedConfig);
    writeJson(join(run.outputDirectory, 'preflight.json'), preflight);
    writeJson(statePath, state);
  }
  if (!run.fixturePack) {
    if (
      options.resume &&
      existsSync(join(run.outputDirectory, 'confirmation.json'))
    ) {
      resolveArtifactReference(
        run.outputDirectory,
        'confirmation.json',
        'resume confirmation.json',
      );
    }
    writeJson(join(run.outputDirectory, 'confirmation.json'), {
      schemaVersion: 1,
      confirmedAt: (dependencies.now?.() ?? new Date()).toISOString(),
      resumed: Boolean(options.resume),
      configFingerprint: run.resolvedConfig.fingerprint,
      preflightFingerprint: fingerprint(preflight),
      remainingOperations: preflight,
    });
  }

  const scores = [];
  for (const entry of Object.values(state.entries)) {
    if (entry.status === 'scored' && entry.scoreFile) {
      scores.push(
        readJson(
          resolveArtifactReference(
            run.outputDirectory,
            entry.scoreFile,
            'resume scoreFile',
          ),
        ),
      );
    }
  }

  for (const question of run.questions) {
    for (const target of run.targets) {
      const key = `${question.id}::${target.id}`;
      let entry = state.entries[key];
      if (entry.status === 'scored') continue;
      dependencies.onProgress?.({ key, status: entry.status });
      const caseRoot = join(
        run.outputDirectory,
        'raw',
        safeSegment(question.id),
        safeSegment(target.id),
      );
      const relativeCaseRoot = caseRoot.slice(run.outputDirectory.length + 1);
      mkdirSync(caseRoot, { recursive: true });
      try {
        let caseData;
        if (entry.status === 'retrieved') {
          caseData = readRecoveredCase(run.outputDirectory, entry);
          assertExactTargetRun(caseData.run, target);
        } else {
          checkpoint(statePath, state, key, {
            status: 'running',
            attempts: entry.attempts + 1,
            error: null,
          });
          if (run.fixturePack) {
            const fixture = run.fixturePack.cases.get(key);
            if (!fixture) throw new Error(`Fixture case not found: ${key}`);
            if (
              fixture.synthesis.provider !== run.config.synthesis.provider ||
              fixture.synthesis.model !== run.config.synthesis.model ||
              fixture.synthesis.modelVersion !==
                run.config.synthesis.modelVersion ||
              fixture.synthesis.promptVersion !==
                run.config.synthesis.promptVersion
            ) {
              throw new Error(
                'Fixture synthesis configuration does not match the pinned synthesis configuration',
              );
            }
            const destination = join(caseRoot, 'librarium-run');
            const parsedRun = copyFixtureRun(fixture, destination);
            assertExactTargetRun(parsedRun, target);
            const answer = fixture.answer;
            const synthesis = fixture.synthesis;
            writeFileSync(join(caseRoot, 'answer.md'), answer, 'utf8');
            writeJson(join(caseRoot, 'synthesis.json'), synthesis);
            caseData = { run: parsedRun, answer, synthesis, fixture };
          } else {
            const parsedRun = await (
              dependencies.executeLiveCase ?? executeLiveCase
            )({
              question,
              target,
              rawDirectory: caseRoot,
              config: run.config,
              env,
              providerConfiguration: run.resolvedConfig.providerConfiguration,
            });
            const synthesis = await synthesizeAnswer(
              question,
              parsedRun,
              run.config,
              env,
              dependencies.fetch,
            );
            writeFileSync(join(caseRoot, 'answer.md'), synthesis.text, 'utf8');
            writeJson(join(caseRoot, 'synthesis.json'), synthesis);
            caseData = { run: parsedRun, answer: synthesis.text, synthesis };
          }
          const rawRunDirectory = caseData.run.runDir.slice(
            run.outputDirectory.length + 1,
          );
          checkpoint(statePath, state, key, {
            status: 'retrieved',
            rawRunDirectory,
            answerFile: join(relativeCaseRoot, 'answer.md'),
            synthesisFile: join(relativeCaseRoot, 'synthesis.json'),
          });
          entry = state.entries[key];
          await dependencies.afterCheckpoint?.({ key, status: 'retrieved' });
        }

        const judge = run.fixturePack
          ? fixtureGrade(
              question,
              caseData.answer,
              caseData.run,
              run.config,
              (caseData.fixture ?? run.fixturePack.cases.get(key)).judgment,
            )
          : await gradeAnswer(
              question,
              caseData.answer,
              caseData.run,
              run.config,
              env,
              dependencies.fetch,
            );
        const judgeFile = join(
          'judge',
          safeSegment(question.id),
          `${safeSegment(target.id)}.json`,
        );
        writeJson(join(run.outputDirectory, judgeFile), {
          schemaVersion: 1,
          questionId: question.id,
          targetId: target.id,
          provider: judge.provider,
          model: judge.model,
          modelVersion: judge.modelVersion,
          promptVersion: run.config.judge.promptVersion,
          blinded: judge.blinded,
          excludesTargetIdentity: judge.excludesTargetIdentity,
          prompt: judge.prompt,
          promptSha256: judge.promptSha256,
          usage: judge.usage,
          costUsd: null,
          costConfidence: 'unknown',
          rawResponse: judge.rawResponse,
          rawText: judge.rawText,
          judgment: judge.judgment,
        });
        const score = scoreCase({
          question,
          target,
          run: caseData.run,
          answer: { content: caseData.answer, synthesis: caseData.synthesis },
          judge,
        });
        const scoreFile = join(
          'scores',
          safeSegment(question.id),
          `${safeSegment(target.id)}.json`,
        );
        writeJson(join(run.outputDirectory, scoreFile), score);
        scores.push(score);
        checkpoint(statePath, state, key, {
          status: 'scored',
          scoreFile,
          judgeFile,
          completedAt: new Date().toISOString(),
        });
      } catch (error) {
        if (error?.benchmarkInterruption === true) throw error;
        checkpoint(statePath, state, key, {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
        if (dependencies.failFast) throw error;
      }
    }
  }

  writeResults(run.outputDirectory, scores);
  const summary = buildSummary({
    run: run.resolvedConfig,
    targets: run.targets,
    scores,
  });
  writeJson(join(run.outputDirectory, 'summary.json'), summary);
  writeFileSync(
    join(run.outputDirectory, 'report.md'),
    renderMarkdownReport(summary),
    'utf8',
  );
  const finalState = readJson(statePath);
  return {
    dryRun: false,
    outputDirectory: run.outputDirectory,
    state: finalState,
    summary,
    preflight,
    expected: Object.values(finalState.entries).length,
    completed: Object.values(finalState.entries).filter(
      (entry) => entry.status === 'scored',
    ).length,
    failed: Object.values(finalState.entries).filter(
      (entry) => entry.status === 'failed',
    ).length,
  };
}
