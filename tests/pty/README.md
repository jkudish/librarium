# PTY smoke tests

End-to-end smoke coverage for librarium's **interactive terminal flows** — the
parts that a normal unit/integration test can't reach because they depend on a
real TTY: the live run table, the wizard, the `browse` list, and the fullscreen
pager.

Each test spawns the **built** CLI (`dist/cli.js`) inside a real pseudo-terminal
(via [`node-pty`](https://github.com/microsoft/node-pty)), feeds scripted
keystrokes, and asserts on the captured terminal output.

## Running

```bash
npm run test:pty        # builds dist/ first, then runs the PTY suite
```

The default `npm test` does **not** include these (they're excluded in
`vitest.config.ts` and driven by `vitest.pty.config.ts`). They are also separate
from the integration and workers suites.

To iterate without rebuilding every time:

```bash
npm run build
npx vitest run --config vitest.pty.config.ts            # all PTY tests
npx vitest run --config vitest.pty.config.ts run.test.ts # one file
```

## Gating

The suite skips cleanly (no failures) when it can't run:

- **Windows** — `process.platform === 'win32'` short-circuits `ptyAvailable()`.
- **node-pty unavailable** — if the native module failed to build/load, tests
  skip with a clear reason in the describe title instead of crashing.

A `globalSetup` asserts `dist/cli.js` exists and fails fast with an actionable
message if you forgot to build.

## How it works

- **`harness.ts`** — spawns the CLI in a PTY with a controlled size/env, exposes
  `waitForText` / `waitFor` / `waitForExit`, a `write()` for keystrokes, a
  `sigint()` for Ctrl+C, an ANSI-strip helper, and a substring `count()` (used
  for alt-screen balance checks). Every session runs against a **fresh isolated
  `HOME`** seeded with a generated `config.json`, so the user's real
  `~/.config/librarium` is never read or written.
- **`tests/fixtures/providers/mock-provider.mjs`** — an offline mock that
  implements librarium's script-provider protocol (`describe` / `execute` /
  `test` over a JSON stdin/stdout envelope). One script serves as many providers;
  behaviour (tier, citation count, latency, forced failure) is driven by the
  `options` block of each provider's config entry. No network, fully
  deterministic.
- **`tests/fixtures/config/mock-config.ts`** — committed scenario specs
  (`HAPPY_PATH`, `FALLBACK_PATH`, `SINGLE`, `SLOW`). `buildMockConfig()` stamps
  in the absolute path to the mock script at runtime (it differs per machine),
  which is why the config is built in code rather than committed as raw JSON.
- **`tests/fixtures/runs/sample-run/`** — a committed run directory (run.json +
  provider markdown) that the `browse` test opens. Its `outputDir`/`timestamp`
  are normalized to fixed values so the fixture is stable.

### macOS note

node-pty shells out to a prebuilt `spawn-helper` binary. npm extraction
sometimes strips its execute bit, which surfaces as an opaque
`posix_spawnp failed`. The harness restores `+x` defensively at load time, so a
fresh `npm install`/`npm ci` doesn't break the suite.

## Adding a test

1. Pick or add a scenario in `mock-config.ts` (or pass an inline
   `MockConfigSpec`).
2. `spawnCli({ args: [...], config })`.
3. `await session.waitForText('<landmark>')` before sending the next keystroke —
   assert on **landmarks** (status lines, glyphs, summary text), not full
   screens, so the tests survive cosmetic changes.
4. Drive keys with `session.write(KEY.DOWN)` etc.; allow a short `delay()`
   between keystrokes so the TUI settles.
5. End by asserting the exit code and (where relevant) cursor restore
   (`[?25h`) or balanced alt-screen (`[?1049h` count == `[?1049l` count).

Menu-navigation tests that depend on option ordering (wizard group pick, browse
quit) assert a guard landmark after navigating, so a future menu change fails
loudly instead of silently doing the wrong thing.
