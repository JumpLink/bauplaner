/**
 * @bauplaner/cli — command-line adapter for the natural-building planner.
 *
 * Thin adapter over the shared kernel (`@bauplaner/core`,
 * `@bauplaner/materials`). Runs on GJS via gjsify (and on Node). The native
 * GNOME/Adwaita GUI will reuse the same kernel in-process; see docs/concept/vision.md.
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import {
  inspectCommand,
  kostenCommand,
  lehmgrabenCommand,
  materialsCommand,
  bauteilCommand,
  feuchteCommand,
  wandCommand,
  wandSetCommand,
} from './commands/index.ts';

function reportError(err: unknown): void {
  if (!(err instanceof Error) || err.name !== 'YError') {
    console.error(err instanceof Error ? err.message : String(err));
  }
  process.exitCode = 1;
}

async function main(): Promise<void> {
  await yargs(hideBin(process.argv))
    .scriptName('bauplaner')
    .command(inspectCommand)
    .command(kostenCommand)
    .command(lehmgrabenCommand)
    .command(materialsCommand)
    .command(bauteilCommand)
    .command(feuchteCommand)
    .command(wandCommand)
    .command(wandSetCommand)
    .demandCommand(1, 'Bitte ein Kommando angeben.')
    .strict()
    .help()
    .parseAsync();
}

main().catch(reportError);
