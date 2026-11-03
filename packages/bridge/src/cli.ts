import { createProgram } from './cli-program.js';
import { delegateToActiveRelease } from './launcher.js';

process.on('SIGINT', () => {
  process.stderr.write('\n[zhunzou] interrupted\n');
  process.exit(130);
});

async function main(): Promise<void> {
  // After `upgrade`, current.json points at a newer versions/<v>/cli.mjs.
  if (await delegateToActiveRelease(import.meta.url)) return;

  await createProgram().parseAsync(process.argv);
}

main().catch((error: unknown) => {
  process.stderr.write(`[zhunzou] ${(error as Error).message}\n`);
  process.exit(1);
});
