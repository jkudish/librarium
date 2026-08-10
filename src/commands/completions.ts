import type { Command, Option } from 'commander';
import { type CompletionShell, parseCompletionShell } from '../cli-parsers.js';
import { DEFAULT_GROUPS } from '../constants.js';

/**
 * Static shell completion scripts (no completion framework dependency).
 * Covers commands, per-command flags, and the builtin group names.
 */

interface CommandSpec {
  name: string;
  description: string;
  flags: string[];
  groupAware: boolean;
}

const GROUP_NAMES = Object.keys(DEFAULT_GROUPS);

function optionFlags(option: Option): string[] {
  return [option.short, option.long].filter(
    (flag): flag is string => typeof flag === 'string',
  );
}

/** Read completion metadata from the same Commander tree used at runtime. */
function commandSpecs(program: Command): CommandSpec[] {
  return program.commands.map((command) => {
    const flags = command.options.flatMap(optionFlags);
    return {
      name: command.name(),
      description: command.description(),
      flags,
      groupAware: command.options.some((option) => option.long === '--group'),
    };
  });
}

function singleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function zshCompletions(program: Command): string {
  const commands = commandSpecs(program);
  const commandLines = commands
    .map(
      (command) =>
        `    ${singleQuote(`${command.name}:${command.description}`)}`,
    )
    .join('\n');
  const cases = commands
    .filter((command) => command.flags.length > 0)
    .map((command) => {
      const flagWords = command.flags.join(' ');
      const groupCase = command.groupAware
        ? `\n      if [[ $words[CURRENT-1] == '-g' || $words[CURRENT-1] == '--group' ]]; then\n        compadd ${GROUP_NAMES.join(' ')}\n        return\n      fi`
        : '';
      return `    ${command.name})${groupCase}\n      compadd -- ${flagWords}\n      ;;`;
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

export function bashCompletions(program: Command): string {
  const commands = commandSpecs(program);
  const names = commands.map((command) => command.name).join(' ');
  const groupAwareNames = commands
    .filter((command) => command.groupAware)
    .map((command) => command.name)
    .join(' ');
  const flagCases = commands
    .filter((command) => command.flags.length > 0)
    .map(
      (command) => `    ${command.name}) flags="${command.flags.join(' ')}" ;;`,
    )
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

  if [[ " ${groupAwareNames} " == *" \${cmd} "* && ( "\${prev}" == "-g" || "\${prev}" == "--group" ) ]]; then
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

export function fishCompletions(program: Command): string {
  const commands = commandSpecs(program);
  const commandLines = commands
    .map(
      (command) =>
        `complete -c librarium -n __fish_use_subcommand -a ${command.name} -d ${singleQuote(command.description)}`,
    )
    .join('\n');
  const flagLines = commands
    .flatMap((command) =>
      command.flags
        .filter((flag) => flag !== '-g' && flag !== '--group')
        .map((flag) => {
          const kind = flag.startsWith('--') ? '-l' : '-s';
          return `complete -c librarium -n '__fish_seen_subcommand_from ${command.name}' ${kind} ${flag.replace(/^-+/, '')}`;
        }),
    )
    .join('\n');
  const groupLine = `complete -c librarium -n '__fish_seen_subcommand_from ${commands
    .filter((command) => command.groupAware)
    .map((command) => command.name)
    .join(' ')}' -s g -l group -a '${GROUP_NAMES.join(' ')}'`;

  return `# librarium fish completions. Install:
#   librarium completions fish > ~/.config/fish/completions/librarium.fish
${commandLines}
${flagLines}
${groupLine}
`;
}

export function registerCompletionsCommand(program: Command): void {
  program
    .command('completions')
    .description('Print a shell completion script (zsh, bash, or fish)')
    .argument('<shell>', 'Shell to generate for', parseCompletionShell)
    .action((shell: CompletionShell) => {
      switch (shell) {
        case 'zsh':
          process.stdout.write(zshCompletions(program));
          break;
        case 'bash':
          process.stdout.write(bashCompletions(program));
          break;
        case 'fish':
          process.stdout.write(fishCompletions(program));
          break;
      }
    });
}
