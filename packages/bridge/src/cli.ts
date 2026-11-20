import { maybeAutoUpgrade } from './auto-upgrade.js';
import { createProgram } from './cli-program.js';
import { delegateToActiveRelease } from './launcher.js';

process.on('SIGINT', () => {
  process.stderr.write('\n[zhunzou] interrupted\n');
  process.exit(130);
});

// A leaked promise must not take the runner down mid-turn: log it and keep
// serving. An uncaught exception leaves process state unknown, so that one
// exits and lets launchd/systemd start a clean process.
process.on('unhandledRejection', (reason) => {
  const detail =
    reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  process.stderr.write(`[zhunzou] unhandled rejection: ${detail}\n`);
});
process.on('uncaughtException', (error) => {
  process.stderr.write(
    `[zhunzou] uncaught exception: ${error.stack ?? error.message}\n`,
  );
  process.exit(1);
});

async function main(): Promise<void> {
  // After `upgrade`, current.json points at a newer versions/<v>/cli.mjs.
  if (await delegateToActiveRelease(import.meta.url)) return;

  // Long-running daemons self-update; short commands (wait/next-task) must not
  // pay for a network round-trip.
  if (process.argv[2] === 'wake' || process.argv[2] === 'fleet') {
    void maybeAutoUpgrade({
      log: (line) => process.stderr.write(`[zhunzou] ${line}\n`),
    });
  }

  await createProgram().parseAsync(process.argv);
}

main().catch((error: unknown) => {
  process.stderr.write(`[zhunzou] ${(error as Error).message}\n`);
  process.exit(1);
});
