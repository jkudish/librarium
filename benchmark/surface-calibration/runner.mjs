import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRunDirectory, parseLibrariumRun } from '../lib/artifacts.mjs';
import {
  fingerprint,
  readJson,
  timestampForPath,
  writeJson,
} from '../lib/io.mjs';
import {
  buildDivergencePrompt,
  compareObservations,
  scoreObservation,
  validateCorpus,
  validateDivergence,
} from './lib.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(root, '..', '..');
const runtimeEnvironmentVariables = [
  'PATH',
  'HOME',
  'SystemRoot',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'TZ',
];

function childEnvironment(env, credential) {
  const result = { NO_COLOR: '1' };
  for (const key of [...runtimeEnvironmentVariables, credential]) {
    if (typeof env[key] === 'string' && env[key] !== '') result[key] = env[key];
  }
  return result;
}

function spawnCapture(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code, signal) =>
      resolvePromise({ code, signal, stdout, stderr }),
    );
  });
}

export function buildPreflight(config, corpus, env = process.env) {
  const caseCount = corpus.cases.length;
  const searchApiUsd =
    caseCount *
    config.collectors[config.referenceCollector].estimatedCostUsdPerRun;
  const maximumJudgeInputUsd =
    (config.judge.maxPromptBytes * config.judge.inputUsdPerMillionTokens) /
    1_000_000;
  const maximumJudgeOutputUsd =
    (config.judge.maxCompletionTokens *
      config.judge.outputUsdPerMillionTokens) /
    1_000_000;
  const maximumJudgeUsd =
    caseCount * (maximumJudgeInputUsd + maximumJudgeOutputUsd);
  const firecrawl = config.collectors[config.routineCandidate];
  return {
    schemaVersion: 1,
    paidCalls: true,
    sequential: true,
    retries: 0,
    caseCount,
    collectorDispatchCount: caseCount * 2,
    judgeCallCount: caseCount,
    maximumProviderHttpRequests:
      caseCount *
      Object.values(config.collectors).reduce(
        (total, collector) =>
          total + collector.maximumProviderRequestsPerPrompt,
        0,
      ),
    knownMaximumUsd: Number((searchApiUsd + maximumJudgeUsd).toFixed(6)),
    knownMaximumUsdBreakdown: {
      searchapi: Number(searchApiUsd.toFixed(6)),
      openaiJudge: Number(maximumJudgeUsd.toFixed(6)),
    },
    firecrawlMaximumCredits: caseCount * firecrawl.maximumCreditsPerRun,
    firecrawlUsd: null,
    credentials: [
      ...Object.values(config.collectors).map((collector) => ({
        envVar: collector.credentialEnvVar,
        available: Boolean(env[collector.credentialEnvVar]),
      })),
      {
        envVar: config.judge.envVar,
        available: Boolean(env[config.judge.envVar]),
      },
    ],
    providerTimeoutSeconds: config.providerTimeoutSeconds,
    judgeTimeoutSeconds: config.judge.timeoutSeconds,
    stopConditions: [
      'provider process or public PHP response failure',
      'authentication, authorization, rate-limit, or timeout failure',
      'missing output, wrong entity, or structurally broken output',
      'challenge or login wall that prevents a usable completion',
      'judge response or artifact validation failure',
    ],
    note: 'Firecrawl monetary cost is unknown and is not included in knownMaximumUsd.',
  };
}

export function validateFixture(fixture, corpus) {
  const errors = [];
  if (fixture?.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (fixture?.corpusVersion !== corpus.version) {
    errors.push(`corpusVersion must be ${corpus.version}`);
  }
  if (!Array.isArray(fixture?.cases)) {
    errors.push('cases must be an array');
    return errors;
  }
  const expectedIds = corpus.cases.map((item) => item.id).sort();
  const actualIds = fixture.cases.map((item) => item?.caseId).sort();
  if (
    actualIds.length !== expectedIds.length ||
    actualIds.some((id, index) => id !== expectedIds[index])
  ) {
    errors.push(
      'cases must match the corpus exactly, without omissions or extras',
    );
  }
  for (const item of fixture.cases) {
    if (!item?.reference || !item?.candidate || !item?.divergence) {
      errors.push(
        `${item?.caseId ?? 'unknown case'} must define reference, candidate, and divergence`,
      );
      continue;
    }
    for (const [role, observation] of [
      ['reference', item.reference],
      ['candidate', item.candidate],
    ]) {
      if (
        typeof observation.answer !== 'string' ||
        typeof observation.completion !== 'boolean' ||
        !observation.provenance?.collector ||
        !observation.provenance?.surface ||
        !Array.isArray(observation.citations) ||
        !observation.cost ||
        !observation.receipt
      ) {
        errors.push(`${item.caseId}.${role} is not a normalized observation`);
      }
    }
    try {
      validateDivergence(item.divergence);
    } catch (error) {
      errors.push(
        `${item.caseId}.divergence: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return errors;
}

function normalizeObservation(providerId, parsed, config) {
  if (parsed.providerOutputs.length !== 1)
    throw new Error(`${providerId} returned an invalid provider count`);
  const output = parsed.providerOutputs[0];
  if (output.provider !== providerId || output.status !== 'success') {
    throw new Error(
      `${providerId} did not produce one successful in-matrix result`,
    );
  }
  let envelope;
  try {
    envelope = JSON.parse(output.content);
  } catch {
    throw new Error(`${providerId} returned a malformed consumer envelope`);
  }
  const expected = config.collectors[providerId];
  if (
    envelope.schemaVersion !== 1 ||
    envelope.provenance?.collector !== expected.collector ||
    envelope.provenance?.surface !== expected.surface
  ) {
    throw new Error(
      `${providerId} returned mismatched collector or surface provenance`,
    );
  }
  const actualUsd = envelope.usage?.costUsd;
  const cost = {
    usd:
      typeof actualUsd === 'number'
        ? actualUsd
        : expected.estimatedCostUsdPerRun,
    confidence:
      typeof actualUsd === 'number'
        ? 'provider-reported'
        : expected.costConfidence,
    creditsUsed: envelope.usage?.creditsUsed ?? null,
  };
  return {
    ...envelope,
    providerId,
    model: output.model,
    durationMs: output.durationMs,
    citations: output.citations.slice(0, 20),
    cost,
  };
}

async function collect(item, providerId, directory, config, env) {
  const cli = join(repositoryRoot, 'dist', 'cli.js');
  if (!existsSync(cli))
    throw new Error('dist/cli.js is missing; run npm run build');
  const outputBase = join(directory, providerId);
  mkdirSync(outputBase, { recursive: true });
  const collector = config.collectors[providerId];
  const result = await spawnCapture(
    process.execPath,
    [
      cli,
      'run',
      item.prompt,
      '--providers',
      providerId,
      '--mode',
      'sync',
      '--output',
      outputBase,
      '--timeout',
      String(config.providerTimeoutSeconds),
      '--no-fallback',
      '--json',
      '--yes',
    ],
    {
      cwd: root,
      env: childEnvironment(env, collector.credentialEnvVar),
    },
  );
  try {
    let manifest;
    try {
      manifest = JSON.parse(result.stdout);
    } catch {
      throw new Error(
        `${providerId} exited ${result.code ?? result.signal ?? 'unknown'} without a JSON manifest`,
      );
    }
    return normalizeObservation(
      providerId,
      parseLibrariumRun(findRunDirectory(outputBase, manifest)),
      config,
    );
  } finally {
    rmSync(outputBase, { recursive: true, force: true });
  }
}

async function judgeDivergence(
  item,
  reference,
  candidate,
  config,
  env,
  fetchImpl = fetch,
) {
  const input = buildDivergencePrompt(
    item,
    reference,
    candidate,
    config.judge.promptVersion,
  );
  if (Buffer.byteLength(input.prompt, 'utf8') > config.judge.maxPromptBytes) {
    throw new Error('Divergence judge prompt exceeds the paid-call byte bound');
  }
  const response = await fetchImpl(
    'https://api.openai.com/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env[config.judge.envVar]}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.judge.model,
        messages: [{ role: 'user', content: input.prompt }],
        max_completion_tokens: config.judge.maxCompletionTokens,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(config.judge.timeoutSeconds * 1000),
    },
  );
  const body = await response.text();
  if (!response.ok)
    throw new Error(`Divergence judge failed with HTTP ${response.status}`);
  const parsed = JSON.parse(body);
  const text = parsed.choices?.[0]?.message?.content;
  if (!text) throw new Error('Divergence judge returned no content');
  return {
    ...validateDivergence(JSON.parse(text)),
    judge: {
      provider: config.judge.provider,
      model: config.judge.model,
      modelVersion: config.judge.modelVersion,
      promptVersion: config.judge.promptVersion,
      promptSha256: input.promptSha256,
      usage: parsed.usage ?? null,
    },
  };
}

export function buildReport(run) {
  const lines = [
    '# Consumer-surface collector calibration',
    '',
    `Run: \`${run.runId}\`  `,
    `Corpus: \`${run.corpusVersion}\`  `,
    `PHP core: \`${run.revisions.core}\`  `,
    `PHP Firecrawl: \`${run.revisions.firecrawl}\``,
    '',
    '| Case | Collector / surface | Usable | Hard failures | Entity | Structure | Citations | Latency ms | USD | Credits | Challenge |',
    '|---|---|:---:|---|:---:|:---:|---:|---:|---:|---:|---|',
  ];
  for (const item of run.results) {
    for (const score of [item.reference, item.candidate]) {
      lines.push(
        `| ${item.caseId} | ${score.collector} / ${score.surface} | ${score.usableCompletion ? 'yes' : 'no'} | ${score.hardFailures.join(', ') || 'none'} | ${score.entity.correct ? 'yes' : 'no'} | ${score.structure.correct ? 'yes' : 'no'} | ${score.citationCount} | ${score.latencyMs ?? 'unknown'} | ${score.cost.usd ?? 'unknown'} | ${score.cost.creditsUsed ?? 'unknown'} | ${score.challenge}${score.loginWall ? ' + login wall' : ''} |`,
      );
    }
    lines.push(
      `| ${item.caseId} | pairwise | — | — | — | — | URL Jaccard ${item.comparison.citationOverlap.jaccard ?? 'unknown'}; host Jaccard ${item.comparison.sourceHostOverlap.jaccard ?? 'unknown'} | — | — | — | semantic divergence: ${item.comparison.materialSemanticDivergence.materialDivergence ? 'yes' : 'no'} (${item.comparison.materialSemanticDivergence.severity}) |`,
    );
  }
  lines.push(
    '',
    '## Role recommendation',
    '',
    run.recommendation.routineEligibleForManualReview
      ? 'Firecrawl is eligible for manual review as the routine ChatGPT-web collector for this exact corpus and declared signed-out context. SearchAPI remains the reference collector. This is not a universal or permanent winner.'
      : 'Do not promote Firecrawl to the routine collector from this run. Keep SearchAPI as the reference collector and investigate the recorded hard failures or material divergence.',
    '',
    'Recalibrate on a schedule owned outside this package and whenever the provider or PHP interface revision changes, the consumer surface changes, challenge/login-wall behavior changes, a routine result fails entity or structure checks, citations drift materially, quality is disputed, or an operator requests a reference result.',
    '',
    'No aggregate score is computed. Collector, effective surface, declared context, receipts, and every individual measure remain in `results.json`.',
    '',
  );
  return `${lines.join('\n')}\n`;
}

export async function executeSurfaceCalibration(
  options = {},
  dependencies = {},
) {
  const config = dependencies.config ?? readJson(join(root, 'config.json'));
  const corpus = dependencies.corpus ?? readJson(join(root, 'corpus.v1.json'));
  const errors = validateCorpus(corpus);
  if (errors.length)
    throw new Error(`Invalid surface corpus:\n- ${errors.join('\n- ')}`);
  const env = dependencies.env ?? process.env;
  const preflight = buildPreflight(config, corpus, env);
  if (options.dryRun) return { dryRun: true, preflight, config, corpus };

  const fixtureMode = options.fixture !== undefined;
  const fixture = fixtureMode ? readJson(resolve(options.fixture)) : null;
  if (fixtureMode) {
    const fixtureErrors = validateFixture(fixture, corpus);
    if (fixtureErrors.length) {
      throw new Error(
        `Invalid surface fixture:\n- ${fixtureErrors.join('\n- ')}`,
      );
    }
  }
  if (!fixtureMode) {
    const missing = preflight.credentials
      .filter((item) => !item.available)
      .map((item) => item.envVar);
    if (missing.length)
      throw new Error(`Missing paid-call credentials: ${missing.join(', ')}`);
    if (
      (await dependencies.confirm?.({ config, corpus, preflight })) !== true
    ) {
      throw new Error('Paid surface calibration was not confirmed');
    }
  }

  const runDate = dependencies.now?.() ?? new Date();
  const runId = timestampForPath(runDate);
  const outputDirectory = join(
    resolve(options.output ?? join(root, 'results')),
    runId,
  );
  mkdirSync(outputDirectory, { recursive: true });
  writeJson(
    join(outputDirectory, 'preflight.json'),
    fixtureMode ? { ...preflight, paidCalls: false, fixture: true } : preflight,
  );
  if (!fixtureMode) {
    writeJson(join(outputDirectory, 'confirmation.json'), {
      schemaVersion: 1,
      confirmedAt: runDate.toISOString(),
      corpusVersion: corpus.version,
      corpusFingerprint: fingerprint(corpus),
      configFingerprint: fingerprint(config),
      preflightFingerprint: fingerprint(preflight),
      authorization: 'interactive-RUN',
    });
  }
  const results = [];
  for (const item of corpus.cases) {
    const caseDirectory = join(outputDirectory, 'cases', item.id);
    mkdirSync(caseDirectory, { recursive: true });
    const fixtureCase = fixture?.cases?.find(
      (candidate) => candidate.caseId === item.id,
    );
    const reference = fixtureMode
      ? fixtureCase.reference
      : await collect(
          item,
          config.referenceCollector,
          caseDirectory,
          config,
          env,
        );
    const candidate = fixtureMode
      ? fixtureCase.candidate
      : await collect(
          item,
          config.routineCandidate,
          caseDirectory,
          config,
          env,
        );
    writeJson(join(caseDirectory, 'reference.normalized.json'), reference);
    writeJson(join(caseDirectory, 'candidate.normalized.json'), candidate);
    const referenceScore = scoreObservation(item, reference);
    const candidateScore = scoreObservation(item, candidate);
    const hardFailures = [
      ...referenceScore.hardFailures,
      ...candidateScore.hardFailures,
    ];
    if (hardFailures.length && !fixtureMode) {
      writeJson(join(caseDirectory, 'hard-failure.json'), {
        hardFailures,
        referenceScore,
        candidateScore,
      });
      throw new Error(`${item.id} hard failure: ${hardFailures.join(', ')}`);
    }
    const divergence = fixtureMode
      ? fixtureCase.divergence
      : await judgeDivergence(
          item,
          reference,
          candidate,
          config,
          env,
          dependencies.fetch,
        );
    const comparison = compareObservations(
      reference,
      candidate,
      validateDivergence(divergence),
    );
    const result = {
      caseId: item.id,
      reference: referenceScore,
      candidate: candidateScore,
      comparison,
    };
    results.push(result);
    writeJson(join(caseDirectory, 'measures.json'), result);
  }
  const routineEligibleForManualReview = results.every(
    (item) =>
      item.candidate.usableCompletion &&
      !item.comparison.materialSemanticDivergence.materialDivergence,
  );
  const run = {
    schemaVersion: 1,
    runId,
    corpusVersion: corpus.version,
    corpusFingerprint: fingerprint(corpus),
    revisions: {
      core: config.coreRevision,
      firecrawl: config.firecrawlRevision,
    },
    surfaceContext: corpus.surfacePair,
    results,
    recommendation: {
      routineCandidate: config.routineCandidate,
      referenceCollector: config.referenceCollector,
      routineEligibleForManualReview,
      automaticPromotion: false,
      permanentWinner: false,
    },
  };
  writeJson(join(outputDirectory, 'results.json'), run);
  writeFileSync(join(outputDirectory, 'report.md'), buildReport(run), 'utf8');
  return { dryRun: false, outputDirectory, run };
}
