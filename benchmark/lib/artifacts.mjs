import { cpSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import { canonicalUrl, readJson } from './io.mjs';

function readOptional(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function canonicalProfileKey(identity) {
  const primary = identity?.target?.primary ?? {};
  const underlying = identity?.target?.underlying;
  return JSON.stringify([
    identity?.provider_id,
    identity?.profile_id,
    primary.model_selection,
    primary.kind ?? null,
    primary.target_id ?? null,
    underlying?.model_selection ?? null,
    underlying?.kind ?? null,
    underlying?.target_id ?? null,
  ]);
}

function canonicalTier(resultKind) {
  if (resultKind === 'research_report') return 'deep-research';
  if (resultKind === 'search_results') return 'raw-search';
  if (resultKind === 'model_answer') return 'llm';
  return 'ai-grounded';
}

function canonicalContent(result) {
  return typeof result.content === 'string'
    ? result.content
    : `\`\`\`json\n${JSON.stringify(result.content, null, 2)}\n\`\`\``;
}

function canonicalUsage(usage) {
  if (!usage) return null;
  const costUsd =
    usage.currency === 'USD' && usage.actual_cost !== undefined
      ? Number(usage.actual_cost)
      : undefined;
  const projected = {
    ...(usage.prompt_tokens !== undefined && {
      inputTokens: usage.prompt_tokens,
    }),
    ...(usage.completion_tokens !== undefined && {
      outputTokens: usage.completion_tokens,
    }),
    ...(Number.isFinite(costUsd) && { costUsd }),
  };
  return Object.keys(projected).length > 0 ? projected : null;
}

function canonicalSources(providerOutputs) {
  const sources = new Map();
  for (const output of providerOutputs) {
    for (const citation of output.citations) {
      const normalizedUrl = canonicalUrl(citation.url);
      if (!normalizedUrl) continue;
      const existing = sources.get(normalizedUrl);
      if (existing) {
        existing.citationCount += 1;
        if (!existing.providers.includes(output.provider)) {
          existing.providers.push(output.provider);
        }
        if (!existing.title && citation.title) existing.title = citation.title;
      } else {
        sources.set(normalizedUrl, {
          url: citation.url,
          normalizedUrl,
          title: citation.title,
          providers: [output.provider],
          citationCount: 1,
          validUrl: true,
        });
      }
    }
  }
  return [...sources.values()].sort(
    (left, right) => right.citationCount - left.citationCount,
  );
}

function invalidCanonicalRun(runDir, reason) {
  throw new Error(
    `${runDir} is not a comparable canonical Librarium run: ${reason}`,
  );
}

function parseCanonicalRun(runDir, manifest) {
  if (
    manifest.kind !== 'canonical-research-run' ||
    manifest.format !== 'librarium.run-json.v3' ||
    manifest.artifact_name !== 'run_manifest' ||
    manifest.artifact_version !== '3.0.0'
  ) {
    invalidCanonicalRun(runDir, 'the run manifest discriminator is invalid');
  }
  const request = manifest.request;
  const state = manifest.coordination_state;
  const response = manifest.terminal_response;
  if (
    !request ||
    !Array.isArray(request.slots) ||
    !Array.isArray(request.fallback_reserve) ||
    !state ||
    !Array.isArray(state.slots) ||
    !Array.isArray(state.attempts) ||
    !Array.isArray(state.reserve) ||
    !Array.isArray(state.pending_fallbacks) ||
    !state.profile_plans_by_identity ||
    typeof state.profile_plans_by_identity !== 'object' ||
    request.slots.length !== state.slots.length
  ) {
    invalidCanonicalRun(runDir, 'the canonical request or state is malformed');
  }
  if (state.status === 'running' || !response) {
    invalidCanonicalRun(runDir, 'the run has not reached a terminal response');
  }
  if (
    !['succeeded', 'partial', 'failed'].includes(response.status) ||
    !Array.isArray(response.results) ||
    !Array.isArray(response.errors) ||
    request.request_id !== state.request_id ||
    response.request_id !== state.request_id
  ) {
    invalidCanonicalRun(
      runDir,
      'the terminal response is malformed or mismatched',
    );
  }
  if (
    request.fallback_reserve.length > 0 ||
    state.reserve.length > 0 ||
    state.pending_fallbacks.length > 0 ||
    state.attempts.some(
      (attempt) =>
        attempt.attempt_number !== 1 ||
        attempt.replaces_attempt_id ||
        attempt.candidate_id,
    ) ||
    response.results.some((result) => result.fallback_reason)
  ) {
    invalidCanonicalRun(
      runDir,
      'benchmark artifacts must not enable or contain provider fallbacks',
    );
  }

  const responseResults = new Map(
    response.results.map((result) => [result.id, result]),
  );
  const stateSlots = new Map(state.slots.map((slot) => [slot.slot_id, slot]));
  const providerOutputs = [...request.slots]
    .sort((left, right) => left.position - right.position)
    .map((requestSlot) => {
      const slot = stateSlots.get(requestSlot.slot_id);
      const profileKey = canonicalProfileKey(requestSlot.primary?.identity);
      const plan = Object.hasOwn(state.profile_plans_by_identity, profileKey)
        ? state.profile_plans_by_identity[profileKey]
        : undefined;
      const attempts = state.attempts.filter(
        (attempt) => attempt.slot_id === requestSlot.slot_id,
      );
      const attempt = attempts[0];
      if (
        !slot ||
        slot.position !== requestSlot.position ||
        canonicalProfileKey(slot.primary?.identity) !== profileKey ||
        !plan ||
        plan.profile_key !== profileKey ||
        canonicalProfileKey(plan.identity) !== profileKey ||
        typeof plan.binding?.adapter_id !== 'string' ||
        attempts.length !== 1 ||
        canonicalProfileKey(attempt.profile?.identity) !== profileKey
      ) {
        invalidCanonicalRun(
          runDir,
          `slot ${requestSlot.slot_id ?? '(unknown)'} does not preserve its exact provider/profile binding`,
        );
      }
      const result = slot.result_id
        ? responseResults.get(slot.result_id)
        : undefined;
      const succeeded = slot.status === 'succeeded';
      if (
        succeeded !== (attempt.status === 'succeeded') ||
        (succeeded &&
          (!result ||
            result.id !== attempt.result_id ||
            result.requested_profile !==
              requestSlot.primary.identity.profile_id ||
            result.provider !== attempt.profile.identity.provider_id ||
            result.profile !== attempt.profile.identity.profile_id)) ||
        (!succeeded && result)
      ) {
        invalidCanonicalRun(
          runDir,
          `slot ${requestSlot.slot_id} has inconsistent terminal evidence`,
        );
      }
      const citations = result
        ? (Array.isArray(result.citations) ? result.citations : []).flatMap(
            (citation) =>
              citation.source?.url
                ? [
                    {
                      url: citation.source.url,
                      title: citation.source.title,
                      snippet: citation.excerpt,
                    },
                  ]
                : [],
          )
        : [];
      const durationMs = result?.provider_meta?.['librarium:duration_ms'];
      return {
        provider: plan.binding.adapter_id,
        profile: `${requestSlot.primary.identity.provider_id}/${requestSlot.primary.identity.profile_id}`,
        tier: canonicalTier(
          result?.provenance?.result_kind ?? requestSlot.primary.result_kind,
        ),
        status: succeeded
          ? 'success'
          : attempt.status === 'timed_out'
            ? 'timeout'
            : 'error',
        durationMs:
          typeof durationMs === 'number' && Number.isFinite(durationMs)
            ? durationMs
            : 0,
        error: attempt.error?.message ?? slot.error?.message,
        model: result?.model ?? null,
        content: result ? canonicalContent(result) : '',
        citations,
        usage: canonicalUsage(result?.usage),
        metering: null,
        rawFiles: { output: null, meta: null },
      };
    });
  if (
    responseResults.size !==
    providerOutputs.filter((output) => output.status === 'success').length
  ) {
    invalidCanonicalRun(
      runDir,
      'the terminal response contains unbound results',
    );
  }
  return {
    runDir,
    manifest,
    providerOutputs,
    sources: canonicalSources(providerOutputs),
  };
}

function isContained(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '' ||
    (!isAbsolute(pathFromRoot) &&
      pathFromRoot !== '..' &&
      !pathFromRoot.startsWith(`..${sep}`))
  );
}

export function resolveArtifactReference(root, reference, label) {
  if (typeof reference !== 'string' || reference.trim() === '') {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  if (isAbsolute(reference)) {
    throw new Error(`${label} must be relative to its artifact root`);
  }
  return resolveWithinArtifactRoot(root, resolve(root, reference), label);
}

function resolveWithinArtifactRoot(root, candidate, label) {
  const resolvedRoot = resolve(root);
  const lexicalCandidate = resolve(candidate);
  if (!isContained(resolvedRoot, lexicalCandidate)) {
    throw new Error(`${label} must stay within its artifact root`);
  }
  let realRoot;
  let realCandidate;
  try {
    realRoot = realpathSync(resolvedRoot);
    realCandidate = realpathSync(lexicalCandidate);
  } catch {
    throw new Error(`${label} does not reference an existing artifact`);
  }
  if (!isContained(realRoot, realCandidate)) {
    throw new Error(`${label} escapes its artifact root through a symlink`);
  }
  return realCandidate;
}

export function parseLibrariumRun(runDirectory) {
  const runDir = resolve(runDirectory);
  const manifest = readJson(
    resolveArtifactReference(runDir, 'run.json', 'run manifest'),
  );
  if (manifest.schemaVersion === 3) {
    return parseCanonicalRun(runDir, manifest);
  }
  if (manifest.version !== 1 || !Array.isArray(manifest.providers)) {
    throw new Error(`${runDir} is not a supported Librarium run artifact`);
  }
  const pending = manifest.providers.filter(
    (provider) => provider.status === 'async-pending',
  );
  if (pending.length > 0 || (manifest.asyncTasks?.length ?? 0) > 0) {
    throw new Error(
      `Deep-research output is not comparable until completed and retrieved: ${pending.map((item) => item.id).join(', ')}`,
    );
  }
  const fallbacks = manifest.providers.filter(
    (provider) => provider.fallbackFor,
  );
  if (fallbacks.length > 0) {
    throw new Error(
      `Benchmark artifacts must not contain provider fallbacks: ${fallbacks.map((item) => `${item.id} for ${item.fallbackFor}`).join(', ')}`,
    );
  }

  const providerOutputs = manifest.providers.map((report) => {
    const metaPath = report.metaFile
      ? resolveArtifactReference(
          runDir,
          report.metaFile,
          `provider ${report.id} metaFile`,
        )
      : null;
    const outputPath = report.outputFile
      ? resolveArtifactReference(
          runDir,
          report.outputFile,
          `provider ${report.id} outputFile`,
        )
      : null;
    const meta = metaPath ? readJson(metaPath) : {};
    return {
      provider: report.id,
      tier: report.tier,
      status: report.status,
      durationMs: report.durationMs,
      error: report.error,
      model: meta.model ?? null,
      content: outputPath ? readOptional(outputPath) : '',
      citations: Array.isArray(meta.citations) ? meta.citations : [],
      usage: report.usage ?? meta.usage ?? null,
      metering: report.metering ?? meta.metering ?? null,
      rawFiles: {
        output: report.outputFile || null,
        meta: report.metaFile || null,
      },
    };
  });
  const sourcesPath = resolveArtifactReference(
    runDir,
    manifest.sources?.file ?? 'sources.json',
    'sources file',
  );
  const sources = existsSync(sourcesPath) ? readJson(sourcesPath) : [];
  for (const source of sources) {
    source.validUrl = canonicalUrl(source.url) !== null;
  }
  return {
    runDir,
    manifest,
    providerOutputs,
    sources,
  };
}

export function loadFixturePack(path) {
  const manifestPath = resolve(path);
  const fixture = readJson(manifestPath);
  if (fixture.schemaVersion !== 1 || !Array.isArray(fixture.cases)) {
    throw new Error(`${manifestPath} is not a benchmark fixture pack`);
  }
  const root = dirname(manifestPath);
  const cases = new Map();
  for (const item of fixture.cases) {
    const key = `${item.questionId}::${item.targetId}`;
    if (cases.has(key)) throw new Error(`Duplicate fixture case ${key}`);
    const runDir = resolveArtifactReference(
      root,
      item.runDirectory,
      `fixture ${key} runDirectory`,
    );
    const judgmentPath = resolveArtifactReference(
      root,
      item.judgmentFile,
      `fixture ${key} judgmentFile`,
    );
    const answerPath = resolveArtifactReference(
      root,
      item.answerFile,
      `fixture ${key} answerFile`,
    );
    const synthesisPath = resolveArtifactReference(
      root,
      item.synthesisFile,
      `fixture ${key} synthesisFile`,
    );
    cases.set(key, {
      ...item,
      parsedRun: parseLibrariumRun(runDir),
      answer: readFileSync(answerPath, 'utf8'),
      synthesis: readJson(synthesisPath),
      judgment: readJson(judgmentPath),
    });
  }
  return { manifestPath, root, fixture, cases };
}

export function copyFixtureRun(caseFixture, destination) {
  cpSync(caseFixture.parsedRun.runDir, destination, {
    recursive: true,
    errorOnExist: false,
  });
  return parseLibrariumRun(destination);
}

export function findRunDirectory(outputBase, manifest) {
  if (manifest?.outputDir) {
    const candidate = resolveWithinArtifactRoot(
      outputBase,
      isAbsolute(manifest.outputDir)
        ? manifest.outputDir
        : resolve(outputBase, manifest.outputDir),
      'Librarium manifest outputDir',
    );
    if (existsSync(resolve(candidate, 'run.json'))) return candidate;
  }
  if (manifest?.slug) {
    const candidate = resolveArtifactReference(
      outputBase,
      manifest.slug,
      'Librarium manifest slug',
    );
    if (existsSync(resolve(candidate, 'run.json'))) return candidate;
  }
  throw new Error(
    `Librarium did not produce a readable run directory under ${basename(outputBase)}`,
  );
}
