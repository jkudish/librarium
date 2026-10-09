import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('installs exactly the build source offline, without a source checkout or release tag', () => {
  const repo = resolve(import.meta.dirname, '../..');
  const home = mkdtempSync(resolve(tmpdir(), 'librarium-skill-integration-'));
  const skill = resolve(home, '.claude/skills/librarium/SKILL.md');
  const expected = readFileSync(resolve(repo, 'SKILL.md'), 'utf8');
  const { version } = JSON.parse(
    readFileSync(resolve(repo, 'package.json'), 'utf8'),
  );
  const denied = resolve(home, 'network-attempt');
  const guard = resolve(home, 'deny-network.cjs');
  try {
    // Only the shipped bundle and runtime dependencies, not the root SKILL.md.
    copyFileSync(resolve(repo, 'dist/cli.js'), resolve(home, 'cli.mjs'));
    symlinkSync(
      resolve(repo, 'node_modules'),
      resolve(home, 'node_modules'),
      'junction',
    );
    writeFileSync(
      guard,
      `const deny = () => {
        require('node:fs').writeFileSync(${JSON.stringify(denied)}, 'denied');
        throw new Error('network denied');
      };
      globalThis.fetch = deny;
      require('node:net').Socket.prototype.connect = deny;
      require('node:tls').connect = deny;
      for (const protocol of ['node:http', 'node:https']) {
        require(protocol).request = deny;
        require(protocol).get = deny;
      }
      for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) {
        require('node:child_process')[method] = deny;
      }
      require('node:module').syncBuiltinESMExports();
      `,
    );
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ['--require', guard, ...args], {
        cwd: home,
        env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH },
        encoding: 'utf8',
        timeout: 15_000,
      });

    // Prove denial works and is recorded even if a future fallback catches it.
    expect(run('-e', 'fetch("https://example.invalid")').status).not.toBe(0);
    expect(existsSync(denied)).toBe(true);
    rmSync(denied);

    const preview = run('cli.mjs', 'install-skill', '--dry-run');
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain(`bundled skill for version ${version}`);
    expect(existsSync(skill)).toBe(false);

    const installed = run('cli.mjs', 'install-skill');
    expect(installed.status, installed.stderr).toBe(0);
    expect(readFileSync(skill, 'utf8')).toBe(expected);

    writeFileSync(skill, 'existing user installation');
    expect(run('cli.mjs', 'install-skill').status).toBe(0);
    expect(readFileSync(skill, 'utf8')).toBe('existing user installation');
    expect(run('cli.mjs', 'install-skill', '--force').status).toBe(0);
    expect(readFileSync(skill, 'utf8')).toBe(expected);
    expect(existsSync(denied)).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
