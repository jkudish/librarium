# Migrate from Librarium 1.x to 2.0

The npm package requires Node.js 22.12 or newer. Before upgrading, let
pending 1.x tasks finish and keep their run directories; 2.0 cannot read them.

```bash
npm install -g librarium@2
# or
brew upgrade jkudish/tap/librarium
librarium --version
librarium setup --check
```

`librarium --version` should print a 2.x version. The first 2.0 command that
loads your config migrates it, as described below. The website has a shorter
[upgrade summary](https://librarium.si/docs/upgrading-to-v2).

## Config migration is automatic and backed up

Loading an unversioned or 1.x config writes its original bytes to
`config.json.v1.backup` before saving version 3. Existing backups are never
overwritten. If backup or validation fails, the new config is not written.
Config v2 never shipped and is not an intermediate migration format.

Provider entries become flat sources. Extra variants become source options
(for example `grok-combined` becomes `grok` with `search: "both"`). `$ENV_VAR`
references become `env:ENV_VAR`. Saved groups keep their names and map members
to sources; the old built-in visibility roster becomes a saved group of
engines. Removed modes and fallback settings produce migration notices.
Review notices and run `librarium setup --check` before spending.

To roll back, copy the new config somewhere safe, restore
`config.json.v1.backup` as `config.json`, and reinstall 1.x with
`npm install -g librarium@1`. Do not overwrite either backup or pending Run
data.

## Command and option replacements

| 1.x | 2.0 |
| --- | --- |
| `run` | `research` |
| `status` | `show` |
| `answer` | `summarize` |
| `ls` | `sources` |
| `init`, `doctor` | `setup`, `setup --check` |
| `-p`, `-g` | `--only` / `--skip` with flat names |
| `--mode` | `--deep` when deep work is intended; execution is automatic |
| `--max-estimated-cost` | `--max-cost` |
| provider `fallback` | no substitution; use `--only` / `--skip` |
| `refine`, `--refine` | removed; write the question directly |

Removed names fail with replacement guidance rather than silently executing.
There are no built-in groups. Engines run only when named in `--only` or a
saved group. `depth: deep` skips sources without deep variants.

## Runs replace old artifacts and library composition

Every paid execution is a stored Run before its first provider call. `show`
does **not** read 1.x run directories; retain those separately and use the
matching 1.x reader. New directories use Run ids, public `run.json`, versioned
private `state.json`, `answers/`, and redacted `evidence/`.

Use `createLibrarium().research/get/sources/summarize`. `librarium/core` is
runtime-neutral with a memory-store default; `librarium` and `librarium/node`
use filesystem storage and v3 config. Custom stores implement four methods
and can run `runStoreContract` from `librarium/testing`.

MCP now has exactly `research`, `get_run`, `list_sources`. Requests use
`question`, `depth`, `only`, `skip`, `max_cost`, `dry_run`, `wait_seconds`.
Read source content with `get_run` plus `source` and `cursor`.

Unknown costs are `null`. Provider-reported charges are never replaced by
estimates or guessed zeroes. Budget admission is catalog-ordered and greedy;
in-flight work can still finish over the cap.
