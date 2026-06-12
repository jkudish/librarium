import { afterEach, describe, expect, it } from 'vitest';
import { SINGLE } from '../fixtures/config/mock-config.js';
import {
  delay,
  KEY,
  type PtySession,
  ptyAvailable,
  skipReason,
  spawnCli,
} from './harness.js';

const describeMaybe = ptyAvailable() ? describe : describe.skip;

/**
 * Number of `↓` presses from the top of the provider-scope menu to reach the
 * committed `smoke` group. The menu is: "all enabled" (0), the six default
 * groups (deep, quick, raw, fast, comprehensive, all → 1..6), then user groups
 * (smoke → 7), then "pick specific providers". If librarium's DEFAULT_GROUPS
 * count changes this will land elsewhere — the test asserts the confirm line
 * names `group "smoke"` so that regression fails loudly rather than silently
 * running the wrong scope.
 */
const DOWN_TO_SMOKE = 7;

describeMaybe(
  `wizard (bare invocation) [${ptyAvailable() ? 'pty' : skipReason()}]`,
  () => {
    let session: (PtySession & { dispose: () => void }) | null = null;

    afterEach(() => {
      session?.kill();
      session?.dispose();
      session = null;
    });

    it('drives query → group → mode → confirm → run → decline browse', async () => {
      // Bare invocation (no args) launches the wizard in a TTY.
      session = spawnCli({ args: [], config: SINGLE });

      // Query prompt.
      await session.waitForText('What do you want to research?');
      session.write('postgres pooling best practices');
      await delay(150);
      session.write(KEY.ENTER);

      // Provider scope: navigate to the committed `smoke` group and select it.
      await session.waitForText('Which providers?');
      for (let i = 0; i < DOWN_TO_SMOKE; i += 1) {
        session.write(KEY.DOWN);
        await delay(40);
      }
      session.write(KEY.ENTER);

      // Execution mode: accept the default (mixed).
      await session.waitForText('Execution mode');
      session.write(KEY.ENTER);

      // Confirm: the summary line must name the smoke group (guards the
      // navigation count above) before we accept the default (Yes).
      await session.waitForText('Fan out');
      expect(session.plain()).toContain('group "smoke"');
      session.write(KEY.ENTER);

      // The run executes the same live table as `librarium run`.
      await session.waitForText('mock-grounded');
      await session.waitForText('succeeded');

      // Post-run browse offer: decline (default is No) and let the wizard exit.
      await session.waitForText('Browse these results now?');
      session.write(KEY.ENTER);

      const { code } = await session.waitForExit();
      const plain = session.plain();

      // Landmark assertions across the whole flow.
      expect(plain).toContain('What do you want to research?');
      expect(plain).toContain('Which providers?');
      expect(plain).toContain('Execution mode');
      expect(plain).toContain('✓');
      expect(plain).toMatch(/1 succeeded, 0 failed/);
      expect(code).toBe(0);
    });
  },
);
