import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Command } from 'commander';
import { registerCompletionsCommand } from './commands/completions.js';
import {
  escapeHtml,
  renderMarkdown,
  safeUrl,
} from './commands/html-report-sanitization.js';
import { registerInstallSkillCommand } from './commands/install-skill.js';
import { registerUpgradeCommand } from './commands/upgrade.js';
import { VERSION } from './constants.js';
import { ConfigV3Schema } from './core/config-v3.js';
import { decimalFromUnits, decimalUnits, type Run } from './core/run.js';
import { SOURCE_CATALOG } from './core/source-catalog.js';
import { createRunMcpServer } from './mcp/run-server.js';
import { configV3Path, loadConfigV3, saveConfigV3 } from './node-config-v3.js';
import { loadRunStore } from './node-run-store.js';
import { createLibrarium } from './run-node-entry.js';

export const REMOVED_COMMANDS: Record<string, string> = {
  run: 'research',
  plan: 'research --dry-run',
  status: 'show',
  answer: 'summarize',
  refine: 'research (query rewriting was removed)',
  ls: 'sources',
  init: 'setup',
  doctor: 'setup --check',
  'live-validation': 'npm run live-validation -- (maintainer script)',
};
export const REMOVED_FLAGS: Record<string, string> = {
  '-p': '--only',
  '--providers': '--only',
  '--provider': '--only',
  '-g': '--only',
  '--group': '--only',
  '--mode': '--deep (execution is automatic)',
  '--no-fallback': '--only/--skip (fallbacks were removed)',
  '--max-estimated-cost': '--max-cost',
  '--refine': 'research (query rewriting was removed)',
};
export function checkRemoved(argv: string[]) {
  if (REMOVED_COMMANDS[argv[0]])
    throw new Error(
      `'${argv[0]}' was removed; use '${REMOVED_COMMANDS[argv[0]].startsWith('npm ') ? '' : 'librarium '}${REMOVED_COMMANDS[argv[0]]}'`,
    );
  for (const token of argv.slice(1)) {
    const flag = token.split('=')[0];
    if (REMOVED_FLAGS[flag])
      throw new Error(`'${flag}' was removed; use ${REMOVED_FLAGS[flag]}`);
    if (token.startsWith('custom:'))
      throw new Error(
        'custom: was removed; use the saved group name in --only/--skip',
      );
  }
}
function print(value: unknown) {
  process.stdout.write(
    `${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`,
  );
}
function display(run: Run, json = false) {
  if (json) {
    print(run);
    return;
  }
  print(`${run.id} ${run.status} (${run.depth})\n${run.question}`);
  for (const result of run.results)
    print(
      `${result.source}: ${result.status}, ${result.citations.length} citations, reported USD ${result.cost.reported ?? 'unknown'}`,
    );
  for (const skip of run.skipped)
    print(`${skip.source}: skipped (${skip.reason})`);
  if (run.status === 'running') print(`Resume: librarium show ${run.id}`);
}
function store() {
  return loadRunStore(loadConfigV3(), configV3Path());
}
async function findRun(id?: string, wait = false) {
  const selected = id ?? (await (await store()).list({ limit: 1 }))[0]?.id;
  if (!selected) throw new Error('No saved Runs; use research first');
  const run = await createLibrarium().get(selected, { wait });
  if (!run) throw new Error('Run not found');
  return run;
}

export function createRunCliProgram(): Command {
  const program = new Command()
    .name('librarium')
    .version(VERSION)
    .description('Research across configured sources; save and resume Runs');
  program
    .command('research <question>')
    .description('Research a question')
    .option('--deep', 'Durable deep research')
    .option('--only <names>', 'Comma-separated source, engine or group names')
    .option('--skip <names>', 'Exclude names after group expansion')
    .option('--max-cost <usd>', 'USD admission and spend cap')
    .option('--dry-run', 'Plan without calls or storage')
    .option('--no-wait', 'Detach after durable submission (requires --deep)')
    .option('--json', 'Print Run JSON')
    .action(async (question, options) => {
      if (!options.wait && !options.deep && !options.dryRun)
        throw new Error('--no-wait requires --deep; quick work runs inline');
      const client = createLibrarium();
      const started = await client.research(question, {
        depth: options.deep ? 'deep' : 'quick',
        only: options.only?.split(','),
        skip: options.skip?.split(','),
        maxCost: options.maxCost,
        dryRun: options.dryRun,
        wait: false,
      });
      if (options.dryRun) {
        display(started, options.json);
        return;
      }
      const detach = () => {
        process.stderr.write(
          `Detached. Resume: librarium show ${started.id}\n`,
        );
        process.exit(130);
      };
      process.once('SIGINT', detach);
      const repository = await store();
      let lastProgress = '';
      const progress = options.json
        ? undefined
        : setInterval(() => {
            void repository.get(started.id).then((doc) => {
              const message =
                doc?.run.results
                  .map((result) => `${result.source}: ${result.status}`)
                  .join(' · ') ?? '';
              if (message !== lastProgress) {
                lastProgress = message;
                process.stderr.write(`${started.id} ${message}\n`);
              }
            });
          }, 250);
      try {
        // With --no-wait, finish write-ahead durable submissions before exiting.
        let run = started;
        if (options.wait || !options.deep)
          run = (await client.get(started.id, { wait: true })) ?? started;
        else
          for (;;) {
            run = (await client.get(started.id)) ?? run;
            const doc = await repository.get(started.id);
            const handles = doc?.state.handles as
              | Record<string, unknown>
              | undefined;
            if (
              run.results.every(
                (result) =>
                  result.status === 'done' ||
                  result.status === 'failed' ||
                  handles?.[result.source],
              )
            )
              break;
            if (
              doc?.state.execution &&
              JSON.stringify(doc.state.execution).includes('acceptance_unknown')
            )
              break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        display(run ?? started, options.json);
      } finally {
        if (progress) clearInterval(progress);
        process.removeListener('SIGINT', detach);
      }
    });
  program
    .command('show [id]')
    .description('Read or resume a Run (latest by default)')
    .option('--wait', 'Wait until terminal')
    .option('--source <name>', 'One source answer and citations')
    .option('--json', 'Print Run JSON')
    .action(async (id, options) => {
      const run = await findRun(id, options.wait);
      if (options.source) {
        const result = run.results.find(
          (result) => result.source === options.source,
        );
        if (!result) throw new Error('Source not found');
        print(
          options.json
            ? result
            : `${result.answer ?? ''}\n${result.citations.map((citation) => citation.url).join('\n')}`,
        );
      } else display(run, options.json);
    });
  program
    .command('summarize [id]')
    .description('Synthesize a stored Run')
    .option('--verify', 'Verify the synthesis')
    .option('--source <name>', 'Synthesis source')
    .option('--max-cost <usd>', 'Summary Run cap')
    .option('--json', 'Print summary Run JSON')
    .action(async (id, options) => {
      const run = await createLibrarium().summarize(await findRun(id), {
        verify: options.verify,
        source: options.source,
        maxCost: options.maxCost,
      });
      print(options.json ? run : (run.results[0]?.answer ?? run.id));
    });
  program
    .command('sources')
    .description('List sources, engines, groups, variants and prices')
    .option('--json', 'Print JSON')
    .action((options) => {
      const sources = createLibrarium().sources();
      print(
        options.json
          ? sources
          : sources
              .map(
                (source) =>
                  `${source.id} (${source.kind}) ${source.configured ? 'set up' : 'not configured'} ${JSON.stringify(source.variants ?? source.members)}`,
              )
              .join('\n'),
      );
    });
  const groups = program.command('groups').description('Saved source lists');
  groups.command('add <name> <names...>').action((name, names: string[]) => {
    const config = loadConfigV3();
    for (const member of names)
      if (!SOURCE_CATALOG.some((source) => source.id === member))
        throw new Error(`unknown_name: ${member}`);
    config.groups[name] = [...new Set(names)];
    saveConfigV3(ConfigV3Schema.parse(config));
    print(`Saved group ${name}`);
  });
  groups.command('remove <name>').action((name) => {
    const config = loadConfigV3();
    delete config.groups[name];
    saveConfigV3(config);
    print(`Removed group ${name}`);
  });
  program
    .command('setup')
    .description('Configure keys, source options and default cap')
    .option('--check', 'Check configuration without network calls')
    .option('--live', 'Explicit live checks')
    .action(async (options) => {
      if (options.live) {
        display(
          await createLibrarium().research(
            'Librarium setup live check: return a brief acknowledgment.',
          ),
        );
        return;
      }
      if (options.check) {
        const sources = createLibrarium().sources();
        print({
          version: 3,
          config: configV3Path(),
          configured: sources
            .filter((source) => source.configured)
            .map((source) => source.id),
          live: false,
        });
        return;
      }
      const prompts = await import('@clack/prompts');
      const config = loadConfigV3();
      const source = await prompts.select({
        message: 'Source to configure',
        options: [
          ...SOURCE_CATALOG.filter((source) => source.kind === 'research').map(
            (source) => ({ value: source.id, label: source.name }),
          ),
          { value: 'engines', label: 'AI engines (SearchAPI collector)' },
        ],
      });
      if (prompts.isCancel(source)) return;
      const definition = SOURCE_CATALOG.find((item) => item.id === source);
      const key = await prompts.password({
        message: `Credential reference (env:NAME), or API key (${definition?.variants?.quick?.env ?? 'SEARCHAPI_API_KEY'})`,
      });
      if (prompts.isCancel(key)) return;
      if (source === 'engines')
        config.engines = {
          ...config.engines,
          collector: 'searchapi',
          key,
          enabled: true,
        };
      else {
        config.sources[source] = {
          ...config.sources[source],
          key,
          enabled: true,
        };
        if (Object.keys(definition?.options ?? {}).length) {
          const sourceOptions = await prompts.text({
            message: `Source options as JSON (blank = defaults): ${Object.keys(definition?.options ?? {}).join(', ')}`,
            initialValue: '',
          });
          if (prompts.isCancel(sourceOptions)) return;
          if (sourceOptions)
            Object.assign(config.sources[source], JSON.parse(sourceOptions));
        }
      }
      const cap = await prompts.text({
        message: 'Default maximum USD (blank = no cap)',
        initialValue: config.max_cost ?? '',
      });
      if (prompts.isCancel(cap)) return;
      config.max_cost = cap || null;
      const synthesis = await prompts.select({
        message: 'Summary source',
        initialValue: config.summarize?.source ?? 'openai',
        options: ['openai', 'claude', 'gemini', 'openrouter'].map((value) => ({
          value,
          label: value,
        })),
      });
      if (prompts.isCancel(synthesis)) return;
      config.summarize = { source: synthesis };
      saveConfigV3(ConfigV3Schema.parse(config));
      print('Setup saved. Use setup --check to inspect availability.');
    });
  program
    .command('mcp')
    .description('Start the three-tool MCP server over stdio')
    .action(async () => {
      const server = createRunMcpServer();
      await server.connect(new StdioServerTransport());
    });
  program
    .command('browse')
    .description('List saved Runs')
    .action(async () => print(await (await store()).list()));
  program
    .command('jsonl [id]')
    .description('Export a Run as one JSON line')
    .option('-o, --output <file>')
    .action(async (id, options) => {
      const line = `${JSON.stringify(await findRun(id))}\n`;
      if (options.output) writeFileSync(resolve(options.output), line);
      else process.stdout.write(line);
    });
  program
    .command('html [id]')
    .description('Export a self-contained Run report')
    .option('-o, --output <file>', 'Output path', 'report.html')
    .action(async (id, options) => {
      const run = await findRun(id);
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(run.question)}</title><style>body{font:16px/1.6 system-ui;max-width:900px;margin:2rem auto;padding:1rem;color:#222}h1{line-height:1.2}section{border-top:1px solid #ddd;margin-top:2rem;padding-top:1rem}pre{white-space:pre-wrap}body{overflow-wrap:anywhere}a{color:#165bbb}img{max-width:100%}table{display:block;overflow:auto}</style></head><body><main><h1>${escapeHtml(run.question)}</h1><p>${escapeHtml(run.id)} · ${run.status} · ${run.depth}</p><p>Reported USD: ${run.cost.reported ?? 'unknown'} · Estimated USD: ${run.cost.estimated ?? 'unknown'} · Cost ${run.cost.complete ? 'complete' : 'incomplete'}</p>${run.summary_of ? `<p>Summary of ${escapeHtml(run.summary_of)}</p>` : ''}${run.results
        .map(
          (result) =>
            `<section><h2>${escapeHtml(result.source)}: ${result.status}</h2>${result.error ? `<p>${escapeHtml(result.error.code)}: ${escapeHtml(result.error.message)}</p>` : ''}${result.answer === null ? '<p>No answer available.</p>' : renderMarkdown(result.answer)}<ul>${result.citations
              .map((citation) => {
                const url = safeUrl(citation.url);
                return `<li>${url ? `<a href="${escapeHtml(url)}" rel="noopener noreferrer">${escapeHtml(citation.title ?? citation.url)}</a>` : escapeHtml(citation.title ?? citation.url)}</li>`;
              })
              .join('')}</ul></section>`,
        )
        .join(
          '',
        )}${run.skipped.length ? `<section><h2>Skipped sources</h2><ul>${run.skipped.map((skip) => `<li>${escapeHtml(skip.source)}: ${skip.reason}</li>`).join('')}</ul></section>` : ''}</main></body></html>`;
      writeFileSync(resolve(options.output), html);
      print(resolve(options.output));
    });
  program
    .command('usage')
    .description('Reported costs in saved Runs (unknown remains unknown)')
    .action(async () => {
      const runs = await (await store()).list({ limit: 100000 });
      const known = runs.flatMap((run) =>
        run.cost.reported === null ? [] : [run.cost.reported],
      );
      print({
        runs: runs.length,
        reported: known.length
          ? decimalFromUnits(
              known.reduce((sum, cost) => sum + decimalUnits(cost), 0n),
            )
          : null,
        complete: runs.length > 0 && runs.every((run) => run.cost.complete),
      });
    });
  program
    .command('cleanup')
    .description('Prune terminal Runs older than runs.keep_days')
    .option('--dry-run')
    .action(async (options) => {
      const config = loadConfigV3();
      if (config.runs.keep_days === null) {
        print('No runs.keep_days configured; nothing deleted');
        return;
      }
      const repository = await store();
      const expired = (await repository.list({ limit: 100000 })).filter(
        (run) =>
          run.status !== 'running' &&
          Date.parse(run.created_at) <
            Date.now() - (config.runs.keep_days as number) * 86400000,
      );
      if (!options.dryRun)
        for (const run of expired) await repository.delete(run.id);
      print({ ids: expired.map((run) => run.id), dry_run: !!options.dryRun });
    });
  const configCommand = program
    .command('config')
    .description('Read and edit v3 configuration');
  configCommand.command('path').action(() => print(configV3Path()));
  configCommand.command('show').action(() => {
    const config = loadConfigV3();
    print({
      ...config,
      sources: Object.fromEntries(
        Object.entries(config.sources).map(([name, source]) => [
          name,
          { ...source, key: source.key ? '[REDACTED]' : undefined },
        ]),
      ),
      engines: Object.fromEntries(
        Object.entries(config.engines).map(([name, value]) => [
          name,
          name === 'key'
            ? '[REDACTED]'
            : value && typeof value === 'object' && 'key' in value
              ? { ...value, key: '[REDACTED]' }
              : value,
        ]),
      ),
    });
  });
  configCommand
    .command('set <path> <value>')
    .action((path: string, value: string) => {
      const config = loadConfigV3() as unknown as Record<string, unknown>;
      const parts = path.split('.');
      if (
        parts.some((part) =>
          ['__proto__', 'prototype', 'constructor'].includes(part),
        )
      )
        throw new Error('Invalid config path');
      let parent = config;
      for (const part of parts.slice(0, -1)) {
        parent[part] ??= {};
        parent = parent[part] as Record<string, unknown>;
      }
      try {
        parent[parts.at(-1) as string] = JSON.parse(value);
      } catch {
        parent[parts.at(-1) as string] = value;
      }
      saveConfigV3(ConfigV3Schema.parse(config));
      print('Configuration saved');
    });
  registerUpgradeCommand(program);
  registerInstallSkillCommand(program);
  registerCompletionsCommand(program);
  return program;
}
