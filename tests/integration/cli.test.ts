import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RunSchema } from '../../src/core/run.js';

const cli = resolve(import.meta.dirname, '../../dist/cli.js');
const home = mkdtempSync(join(tmpdir(), 'librarium-surface-cli-'));
const runs = join(home, 'runs');
mkdirSync(join(home, '.config/librarium'), { recursive: true });
writeFileSync(
  join(home, '.config/librarium/config.json'),
  JSON.stringify({
    version: 3,
    sources: {
      kagi: { key: 'env:KAGI_API_KEY' },
      exa: { key: 'env:EXA_API_KEY' },
    },
    runs: { path: runs },
  }),
);
afterAll(() => rmSync(home, { recursive: true, force: true }));
function run(args: string[], transport = 'network-denied', env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: home,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      HOME: home,
      USERPROFILE: home,
      PATH: process.env.PATH,
      KAGI_API_KEY: 'dummy-kagi',
      EXA_API_KEY: 'dummy-exa',
      NODE_OPTIONS: `--import=${resolve(import.meta.dirname, `../fixtures/${transport}.mjs`)}`,
      ...env,
    },
  });
}
describe('built Run CLI, offline only', () => {
  it('documents only the replacement command tree and gives replacement errors', () => {
    const help = run(['--help']);
    expect(help.status).toBe(0);
    for (const name of [
      'research',
      'show',
      'summarize',
      'sources',
      'groups',
      'setup',
      'mcp',
      'browse',
      'html',
      'jsonl',
      'usage',
      'cleanup',
    ])
      expect(help.stdout).toContain(name);
    for (const [name, replacement] of [
      ['run', 'research'],
      ['plan', '--dry-run'],
      ['status', 'show'],
      ['answer', 'summarize'],
      ['doctor', 'setup --check'],
      ['ls', 'sources'],
    ]) {
      const result = run([name]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(replacement);
    }
    expect(run(['research', 'q', '--mode', 'mixed']).stderr).toContain(
      '--deep',
    );
  });
  it('smokes dry-run, sources and setup --check with dummy keys, without storage or calls', () => {
    const detachedQuick = run(['research', 'offline', '--no-wait']);
    expect(detachedQuick.status).toBe(1);
    expect(detachedQuick.stderr).toContain('--no-wait requires --deep');
    expect(existsSync(runs)).toBe(false);
    const result = run([
      'research',
      'offline',
      '--only',
      'kagi',
      '--dry-run',
      '--no-wait',
      '--json',
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(RunSchema.parse(JSON.parse(result.stdout)).status).toBe('planned');
    expect(existsSync(runs)).toBe(false);
    expect(JSON.parse(run(['sources', '--json']).stdout)).toHaveLength(21);
    expect(JSON.parse(run(['setup', '--check']).stdout)).toMatchObject({
      version: 3,
      live: false,
      configured: ['exa', 'kagi'],
    });
    expect(
      run([
        'config',
        'set',
        'engines.chatgpt',
        JSON.stringify({ key: 'dummy-private-engine-key' }),
      ]).status,
    ).toBe(0);
    const shown = run(['config', 'show']);
    expect(shown.status).toBe(0);
    expect(JSON.parse(shown.stdout).engines.chatgpt.key).toBe('[REDACTED]');
    expect(shown.stdout).not.toContain('dummy-private-engine-key');
  });
  it('writes a quick Run, reads latest, and keeps history/export/usage tools on the Run layout', () => {
    const result = run(
      ['research', 'Australia', '--only', 'kagi', '--json'],
      'run-transport',
    );
    expect(result.status, result.stderr).toBe(0);
    const doc = RunSchema.parse(JSON.parse(result.stdout));
    expect(doc.status).toBe('done');
    expect(doc.results[0].answer).toContain('Canberra');
    expect(
      JSON.parse(readFileSync(join(runs, doc.id, 'run.json'), 'utf8')),
    ).toEqual(doc);
    expect(JSON.parse(run(['show', '--json']).stdout)).toEqual(doc);
    expect(JSON.parse(run(['browse']).stdout)[0].id).toBe(doc.id);
    expect(JSON.parse(run(['jsonl', doc.id]).stdout)).toEqual(doc);
    expect(JSON.parse(run(['usage']).stdout)).toMatchObject({
      reported: null,
      complete: false,
    });
    const output = join(home, 'report.html');
    expect(run(['html', doc.id, '-o', output]).status).toBe(0);
    expect(readFileSync(output, 'utf8')).toContain('Canberra');
    const statePath = join(runs, doc.id, 'run.json');
    doc.results[0].answer =
      '## Findings\n\n<script>window.evidenceRan = true</script>\n\n[unsafe](javascript:alert(1))';
    writeFileSync(statePath, JSON.stringify(doc));
    expect(run(['html', doc.id, '-o', output]).status).toBe(0);
    const html = readFileSync(output, 'utf8');
    expect(html).toContain('<h2>Findings</h2>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript:');
  });
  it('durably detaches deep work and resumes from a new process without submitting again', () => {
    const result = run(
      ['research', 'deep q', '--deep', '--only', 'exa', '--no-wait', '--json'],
      'run-transport',
    );
    expect(result.status, result.stderr).toBe(0);
    const started = RunSchema.parse(JSON.parse(result.stdout));
    expect(started.status).toBe('running');
    const state = JSON.parse(
      readFileSync(join(runs, started.id, 'state.json'), 'utf8'),
    );
    expect(state.version).toBeGreaterThan(0);
    expect(state.state.handles).toHaveProperty('exa');
    const resumed = run(
      ['show', started.id, '--wait', '--json'],
      'run-transport',
      { FIXTURE_COMPLETE: 'true' },
    );
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({
      status: 'done',
      cost: { reported: '0.74184', complete: true },
    });
    expect(
      JSON.parse(readFileSync(join(home, 'calls.json'), 'utf8')).filter(
        (call: { url: string; method: string }) =>
          call.url.includes('exa.ai') && call.method === 'POST',
      ),
    ).toHaveLength(1);
  });
});
