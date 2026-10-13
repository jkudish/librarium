import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KEY, ptyAvailable, spawnCli } from './harness.js';

const transport = resolve(import.meta.dirname, '../fixtures/run-transport.mjs');
const env = { KAGI_API_KEY: 'dummy', NODE_OPTIONS: `--import=${transport}` };
const configV3 = {
  version: 3 as const,
  sources: { kagi: { key: 'env:KAGI_API_KEY' } },
  runs: { path: './runs' },
};
const describePty = ptyAvailable() ? describe : describe.skip;
describePty('Run terminal surface (offline)', () => {
  let session: ReturnType<typeof spawnCli> | undefined;
  afterEach(() => {
    session?.kill();
    session?.dispose();
    session = undefined;
  });
  it('shows live progress and a completed quick Run without leaking credentials', async () => {
    session = spawnCli({
      args: ['research', 'Australia', '--only', 'kagi'],
      configV3,
      env: { ...env, FIXTURE_DELAY: '600' },
    });
    await session.waitForText('kagi: running');
    expect((await session.waitForExit()).code).toBe(0);
    expect(session.plain()).toContain('kagi: done');
    expect(session.plain()).toContain('reported USD unknown');
    expect(session.plain()).not.toContain('dummy');
  });
  it('Ctrl-C detaches and show marks interrupted inline work failed without resubmission', async () => {
    session = spawnCli({
      args: ['research', 'interrupt me', '--only', 'kagi'],
      configV3,
      env: { ...env, FIXTURE_DELAY: '10000' },
    });
    await session.waitForText('kagi: running');
    session.sigint();
    expect((await session.waitForExit()).code).toBe(130);
    const id = session
      .plain()
      .match(/Resume: librarium show (run_[A-Z0-9]+)/)?.[1];
    expect(id).toBeDefined();
    const home = session.home;
    const next = spawnCli({
      args: ['show', id as string, '--json'],
      cwd: home,
      env: { ...env, HOME: home },
    });
    try {
      expect((await next.waitForExit()).code).toBe(0);
      expect(next.plain()).toContain('interrupted');
      expect(
        JSON.parse(readFileSync(join(home, 'calls.json'), 'utf8')),
      ).toHaveLength(1);
      expect(readdirSync(join(home, 'runs'))).toContain(id);
    } finally {
      next.kill();
      next.dispose();
    }
  });
  it('setup masks its credential prompt and writes validated config v3', async () => {
    session = spawnCli({
      args: ['setup'],
      env: {
        NODE_OPTIONS: `--import=${resolve(import.meta.dirname, '../fixtures/network-denied.mjs')}`,
      },
    });
    await session.waitForText('Source to configure');
    session.write(KEY.ENTER);
    await session.waitForText('Credential reference');
    session.write(`env:BRAVE_API_KEY${KEY.ENTER}`);
    await session.waitForText('Source options as JSON');
    session.write(KEY.ENTER);
    await session.waitForText('Default maximum USD');
    session.write(`1.25${KEY.ENTER}`);
    await session.waitForText('Summary source');
    session.write(KEY.ENTER);
    expect((await session.waitForExit()).code).toBe(0);
    expect(
      JSON.parse(
        readFileSync(
          join(session.home, '.config/librarium/config.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({
      version: 3,
      sources: { brave: { key: 'env:BRAVE_API_KEY' } },
      max_cost: '1.25',
      summarize: { source: 'openai' },
    });
  });
});
