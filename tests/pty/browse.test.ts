import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  count,
  delay,
  KEY,
  type PtySession,
  ptyAvailable,
  skipReason,
  spawnCli,
} from './harness.js';

const describeMaybe = ptyAvailable() ? describe : describe.skip;

// Committed fixture run directory lives under tests/fixtures/runs; browse
// discovers the `sample-run` subdir within this base directory.
const RUNS_BASE = resolve(
  fileURLToPath(new URL('../fixtures/runs', import.meta.url)),
);

const ALT_ON = '[?1049h';
const ALT_OFF = '[?1049l';

/**
 * Run-view select menu order (see browse.ts): two provider rows, then
 * "open summary.md", "export HTML report", "export JSONL", "back", "quit".
 * From the top, six ↓ presses reach "quit".
 */
const DOWN_TO_QUIT = 6;

describeMaybe(
  `browse + pager [${ptyAvailable() ? 'pty' : skipReason()}]`,
  () => {
    let session: (PtySession & { dispose: () => void }) | null = null;

    afterEach(() => {
      session?.kill();
      session?.dispose();
      session = null;
    });

    it('opens a run, pages a provider, returns, and quits with balanced alt-screen', async () => {
      session = spawnCli({
        args: ['browse', '-o', RUNS_BASE],
        // No mock providers needed: browse reads a committed run manifest.
        config: { providers: [] },
      });

      // Run list → select the fixture run.
      await session.waitForText('Recent runs');
      session.write(KEY.ENTER);

      // Run view → select the first provider, opening the fullscreen pager.
      await session.waitForText('export HTML report');
      await delay(150);
      session.write(KEY.ENTER);

      // Pager status line is the landmark that the pager rendered.
      await session.waitForText('j/k scroll');
      expect(session.plain()).toMatch(/mock-grounded.+\d+\/\d+/);

      // Scroll: line down (j) then page down (space). Content is long enough
      // that the position indicator advances off "top".
      session.write(KEY.j);
      await delay(120);
      session.write(KEY.SPACE);
      await delay(120);

      // Scrolling must actually move the viewport: a non-top position label
      // (percentage or "bot") must appear. The transcript keeps scrollback,
      // so the initial "top" line legitimately remains present.
      expect(session.plain()).toMatch(/mock-grounded\s+(\d+%|bot) \d+\//);

      // q returns from the pager to the run view (alt-screen exits).
      session.write(KEY.q);
      await delay(300);
      await session.waitForText('export HTML report');

      // Navigate to the "quit" option and select it.
      for (let i = 0; i < DOWN_TO_QUIT; i += 1) {
        session.write(KEY.DOWN);
        await delay(60);
      }
      session.write(KEY.ENTER);

      const { code } = await session.waitForExit();
      const out = session.output();

      // The pager entered and left the alternate screen buffer exactly once and
      // in balance — no leaked alt-screen state on exit.
      const onCount = count(out, ALT_ON);
      const offCount = count(out, ALT_OFF);
      expect(onCount).toBeGreaterThanOrEqual(1);
      expect(onCount).toBe(offCount);

      // Clean exit via the clack outro line (anchored, not a bare substring).
      expect(session.plain()).toMatch(/\bdone\b/);
      expect(code).toBe(0);
    });
  },
);
