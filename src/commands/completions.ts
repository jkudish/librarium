import type { Command } from 'commander';
import { DEFAULT_GROUPS } from '../constants.js';

/**
 * Static shell completion scripts (no completion framework dependency).
 * Covers commands, per-command flags, and the builtin group names.
 */

interface CommandSpec {
  name: string;
  description: string;
  flags: string[];
}

/** Commands that accept a -g/--group flag and so get group-name completion. */
const GROUP_AWARE_COMMANDS = new Set(['run', 'answer']);

const COMMANDS: CommandSpec[] = [
  {
    name: 'run',
    description: 'Run a research query across providers',
    flags: [
      '--providers',
      '--group',
      '--mode',
      '--output',
      '--parallel',
      '--timeout',
      '--json',
      '--html',
      '--open',
      '--refine',
    ],
  },
  {
    name: 'answer',
    description: 'Synthesize one grounded, cited answer from a fan-out',
    flags: [
      '--providers',
      '--group',
      '--mode',
      '--output',
      '--parallel',
      '--timeout',
      '--json',
      '--refine',
      '--html',
      '--jsonl',
      '--open',
    ],
  },
  {
    name: 'status',
    description: 'Check async deep-research tasks',
    flags: ['--wait', '--retrieve', '--json'],
  },
  {
    name: 'browse',
    description: 'Browse past runs interactively',
    flags: ['--output'],
  },
  {
    name: 'html',
    description: 'Generate report.html for a run',
    flags: ['--open'],
  },
  {
    name: 'refine',
    description: 'Rewrite a query into tier-tuned variants',
    flags: ['--json'],
  },
  { name: 'ls', description: 'List providers', flags: ['--json'] },
  { name: 'groups', description: 'List or manage groups', flags: ['--json'] },
  { name: 'init', description: 'Set up configuration', flags: ['--auto'] },
  { name: 'doctor', description: 'Provider health check', flags: ['--json'] },
  { name: 'config', description: 'Show resolved config', flags: ['--json'] },
  {
    name: 'cleanup',
    description: 'Delete old run directories',
    flags: ['--days', '--dry-run'],
  },
  { name: 'upgrade', description: 'Upgrade librarium', flags: [] },
  {
    name: 'install-skill',
    description: 'Install the agent skill',
    flags: [],
  },
  {
    name: 'completions',
    description: 'Print shell completion script',
    flags: [],
  },
];

const GROUP_NAMES = Object.keys(DEFAULT_GROUPS);

export function zshCompletions(): string {
  const commandLines = COMMANDS.map(
    (c) => `    '${c.name}:${c.description}'`,
  ).join('\n');
  const cases = COMMANDS.filter((c) => c.flags.length > 0)
    .map((c) => {
      const flagWords = c.flags.join(' ');
      const groupCase = GROUP_AWARE_COMMANDS.has(c.name)
        ? `\n      if [[ $words[CURRENT-1] == '-g' || $words[CURRENT-1] == '--group' ]]; then\n        compadd ${GROUP_NAMES.join(' ')}\n        return\n      fi`
        : '';
      return `    ${c.name})${groupCase}\n      compadd -- ${flagWords}\n      ;;`;
    })
    .join('\n');

  return `#compdef librarium
# librarium zsh completions. Install:
#   librarium completions zsh > "\${fpath[1]}/_librarium"
# or: eval "$(librarium completions zsh)"
_librarium() {
  local -a _librarium_commands
  _librarium_commands=(
${commandLines}
  )
  if (( CURRENT == 2 )); then
    _describe -t commands 'librarium command' _librarium_commands
    return
  fi
  case $words[2] in
${cases}
  esac
}
if [[ "$funcstack[1]" == "_librarium" ]]; then
  _librarium "$@"
else
  compdef _librarium librarium
fi
`;
}

export function bashCompletions(): string {
  const names = COMMANDS.map((c) => c.name).join(' ');
  const flagCases = COMMANDS.filter((c) => c.flags.length > 0)
    .map((c) => `    ${c.name}) flags="${c.flags.join(' ')}" ;;`)
    .join('\n');

  return `# librarium bash completions. Install:
#   eval "$(librarium completions bash)"
_librarium_completions() {
  local cur prev cmd flags
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cmd="\${COMP_WORDS[1]}"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${names}" -- "\${cur}") )
    return
  fi

  if [[ "\${prev}" == "-g" || "\${prev}" == "--group" ]]; then
    COMPREPLY=( $(compgen -W "${GROUP_NAMES.join(' ')}" -- "\${cur}") )
    return
  fi

  flags=""
  case "\${cmd}" in
${flagCases}
  esac
  COMPREPLY=( $(compgen -W "\${flags}" -- "\${cur}") )
}
complete -F _librarium_completions librarium
`;
}

export function fishCompletions(): string {
  const commandLines = COMMANDS.map(
    (c) =>
      `complete -c librarium -n __fish_use_subcommand -a ${c.name} -d '${c.description}'`,
  ).join('\n');
  const flagLines = COMMANDS.flatMap((c) =>
    c.flags.map(
      (flag) =>
        `complete -c librarium -n '__fish_seen_subcommand_from ${c.name}' -l ${flag.replace(/^--/, '')}`,
    ),
  ).join('\n');
  const groupLine = `complete -c librarium -n '__fish_seen_subcommand_from ${[
    ...GROUP_AWARE_COMMANDS,
  ].join(' ')}' -s g -l group -a '${GROUP_NAMES.join(' ')}'`;

  return `# librarium fish completions. Install:
#   librarium completions fish > ~/.config/fish/completions/librarium.fish
${commandLines}
${flagLines}
${groupLine}
`;
}

export function registerCompletionsCommand(program: Command): void {
  program
    .command('completions <shell>')
    .description('Print a shell completion script (zsh, bash, or fish)')
    .action((shell: string) => {
      switch (shell) {
        case 'zsh':
          process.stdout.write(zshCompletions());
          break;
        case 'bash':
          process.stdout.write(bashCompletions());
          break;
        case 'fish':
          process.stdout.write(fishCompletions());
          break;
        default:
          console.error(
            `Unsupported shell "${shell}". Supported: zsh, bash, fish.`,
          );
          process.exitCode = 2;
      }
    });
}
