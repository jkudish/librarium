import { Command } from 'commander';
import { registerLiveValidationCommand } from './commands/live-validation.js';
import { replayCanonicalLiveValidationFixture } from './node-live-validation-fixture.js';

/** Private maintainer workflow, not registered by the public CLI. */
export function createMaintainerProgram(): Command {
  const program = new Command().name('librarium-maintainer');
  registerLiveValidationCommand(program, {
    fixtureReplay: replayCanonicalLiveValidationFixture,
  });
  return program;
}
