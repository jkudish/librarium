import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { SOURCE_CATALOG } from '../src/core/source-catalog.js';
import { createRunCliProgram } from '../src/run-cli-program.js';

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
it('documents the simplified catalog, commands, package entries and MCP roster', () => {
  const readme = read('README.md');
  const skill = read('SKILL.md');
  for (const source of SOURCE_CATALOG)
    expect(readme).toContain(`\`${source.id}\``);
  for (const command of createRunCliProgram().commands)
    expect(readme, command.name()).toMatch(
      new RegExp(`\`${command.name()}(?:\`|[ \\[])`),
    );
  for (const name of ['research', 'get_run', 'list_sources'])
    expect(skill).toContain(name);
  for (const document of [
    skill,
    read('docs/research-options.md'),
    read('docs/provider-development.md'),
  ])
    expect(document).not.toMatch(
      /librarium (?:run|plan|status|answer|doctor|init)\b|list_providers|get_results|check_async/,
    );
  expect(Object.keys(JSON.parse(read('package.json')).exports)).toEqual([
    '.',
    './core',
    './node',
    './testing',
  ]);
  expect(read('CHANGELOG.md')).toContain('2.0.0 — Unreleased');
  expect(read('docs/migration-v1-to-v2.md')).toContain('backup');
});
