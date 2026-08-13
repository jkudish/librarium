import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createCliProgram } from '../src/cli-program.js';
import { DEFAULT_GROUPS, PROVIDER_ENV_VARS } from '../src/constants.js';

/**
 * Docs-drift guard for README.md.
 *
 * The README is the front door for first-time visitors, so it must not silently
 * fall out of sync with the CLI surface. This test builds the SAME commander
 * program cli.ts wires up (by calling every registration function), then asserts
 * the README documents every command, every long flag of the user-facing
 * commands, the provider count, the tier names, and the group names.
 *
 * When this fails, the message names exactly what to add to README.md -- treat
 * it as a checklist, not a puzzle. If a command/flag/provider/group was
 * intentionally added or renamed, update README.md (and, if the count changed,
 * the "25 built-in provider adapters" / tier / group prose) to match.
 */

const README = readFileSync(
  fileURLToPath(new URL('../README.md', import.meta.url)),
  'utf-8',
);

const program = createCliProgram();

function commandSection(commandName: string): string {
  const heading = `### \`${commandName}\``;
  const start = README.indexOf(heading);
  if (start === -1) return '';
  const rest = README.slice(start + heading.length);
  const nextHeading = rest.search(/^### /m);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

describe('README drift: commands', () => {
  const commandNames = program.commands.map((c) => c.name());

  it('documents every registered command name', () => {
    const missing = commandNames.filter((name) => !README.includes(name));
    expect(
      missing,
      `README.md is missing these command(s): ${missing.join(', ')}. ` +
        'Add a section (or mention) for each under "## Commands".',
    ).toEqual([]);
  });
});

describe('README drift: command flags', () => {
  // The user-facing commands whose long flags the README documents in tables.
  // (Wizard-only / trivial commands like `completions`, `doctor`, `init`,
  // `config`, `upgrade`, `mcp` carry no flag tables to drift against.)
  const FLAG_DOCUMENTED_COMMANDS = [
    'run',
    'answer',
    'status',
    'browse',
    'cleanup',
    'clear',
    'jsonl',
    'html',
    'usage',
  ];

  for (const commandName of FLAG_DOCUMENTED_COMMANDS) {
    it(`documents every long flag of \`${commandName}\``, () => {
      const command = program.commands.find((c) => c.name() === commandName);
      expect(
        command,
        `command \`${commandName}\` is not registered`,
      ).toBeDefined();
      if (!command) return;

      // Long-form flags only (e.g. `--providers`). `--help` is implicit and
      // never documented, so skip it.
      const longFlags = command.options
        .map((opt) => opt.long)
        .filter((long): long is string => Boolean(long) && long !== '--help');

      // Answer mirrors most of run's options, so scope its assertion to the
      // answer section; a run-table mention must not mask answer-doc drift.
      const documentation =
        commandName === 'answer' ? commandSection(commandName) : README;
      const missing = longFlags.filter((flag) => !documentation.includes(flag));
      expect(
        missing,
        `README.md (\`${commandName}\` section) is missing flag(s): ${missing.join(', ')}.`,
      ).toEqual([]);
    });
  }
});

describe('README drift: providers, tiers, and groups', () => {
  it('states the correct built-in provider count', () => {
    const providerCount = Object.keys(PROVIDER_ENV_VARS).length;
    expect(providerCount).toBe(36); // tripwire: bump the prose below if this changes
    expect(
      README.includes(`${providerCount} built-in provider adapters`),
      `README.md should say "${providerCount} built-in provider adapters" in the Providers intro.`,
    ).toBe(true);
  });

  it('names all four provider tiers', () => {
    const tiers = ['deep-research', 'ai-grounded', 'raw-search', 'llm'];
    const missing = tiers.filter((tier) => !README.includes(tier));
    expect(
      missing,
      `README.md does not mention tier(s): ${missing.join(', ')}.`,
    ).toEqual([]);
  });

  it('names every built-in provider ID', () => {
    const missing = Object.keys(PROVIDER_ENV_VARS).filter(
      (id) => !README.includes(`\`${id}\``),
    );
    expect(missing).toEqual([]);
  });

  it('names every default group', () => {
    const groupNames = Object.keys(DEFAULT_GROUPS);
    expect(groupNames.length).toBe(8); // deep, quick, raw, fast, visibility, comprehensive, llm, all
    // Each group name appears as an inline code span in the Groups table.
    const missing = groupNames.filter(
      (name) => !README.includes(`\`${name}\``),
    );
    expect(
      missing,
      `README.md does not document group(s) as \`name\`: ${missing.join(', ')}.`,
    ).toEqual([]);
  });

  it('keeps the grounded all-group count aligned with the registry', () => {
    const groundedCount = DEFAULT_GROUPS.all.length;
    expect(groundedCount).toBe(32);
    expect(README).toContain(`All ${groundedCount} grounded providers`);
    expect(README).not.toContain('All 20 grounded providers');
  });

  it('keeps visibility provenance, retention, and cost caveats documented', () => {
    expect(README).toContain('not the official OpenAI');
    expect(README).toContain('correlated evidence');
    expect(README).toContain(
      'Bearer authentication is live-validated across all',
    );
    expect(README).toContain('Zero retention remains an account capability');
    expect(README).toContain('interactive setup lists them unselected');
    expect(README).toContain('Perplexity reports its actual cost only after');
    expect(README).toMatch(
      /exact account behavior remains\s+unverified until the separately approved live validation/,
    );
    expect(README).toContain('logical billing units');
  });
});
