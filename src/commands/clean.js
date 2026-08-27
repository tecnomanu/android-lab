// Destructive commands, kept apart so they are easy to audit.
// wipe    -> factory reset, keeps the downloaded SDK and the device definition
// remove  -> deletes the device, keeps the SDK (the ~5 GB you waited for)
// purge   -> deletes everything, including the SDK
import { rmSync } from 'node:fs';
import path from 'node:path';
import { c, confirm, ok, say, step, warn } from '../log.js';
import { cfg, paths } from '../platform.js';
import { listInstances } from '../state.js';

export default async function clean(be, args) {
  const mode = args.all ? 'purge' : args.remove ? 'remove' : 'wipe';
  const yes = args.yes || args.y;

  if (mode === 'wipe') {
    say(`This factory-resets ${c.bold(cfg.name)}: apps, settings and files inside the device are lost.`);
    say(c.dim('The downloaded SDK and the device itself stay, so no re-download.'));
    if (!await confirm('Wipe it?', { assumeYes: yes })) return say('cancelled.');
    if (be.running()) { step('stopping it first'); await be.stop(); }
    be.wipe();
    return ok(`${cfg.name} wiped. Next start comes up factory-fresh.`);
  }

  if (mode === 'remove') {
    say(`This deletes the device ${c.bold(cfg.name)} entirely.`);
    say(c.dim('The downloaded SDK stays, so creating it again does not re-download ~5 GB.'));
    if (!await confirm('Remove it?', { assumeYes: yes })) return say('cancelled.');
    if (be.running()) { step('stopping it first'); await be.stop(); }
    be.destroy();
    return ok(`${cfg.name} removed.`);
  }

  // purge
  const others = listInstances();
  say(`This deletes ${c.bold('everything')} under ${paths().home}:`);
  say(`  ${c.dim('· every device')} ${others.length ? c.dim(`(${others.map((i) => i.name).join(', ')})`) : ''}`);
  say(`  ${c.dim('· the downloaded SDK and system images (~5 GB — you will re-download to use it again)')}`);
  say(`  ${c.dim('· logs and screenshots')}`);
  warn('This cannot be undone.');
  if (!await confirm('Purge everything?', { assumeYes: yes })) return say('cancelled.');

  if (be.running()) { step('stopping the running device'); await be.stop(); }
  for (const dir of ['sdk', 'avd', 'logs', 'redroid-data']) {
    rmSync(path.join(paths().home, dir), { recursive: true, force: true });
  }
  rmSync(paths().state, { force: true });
  ok(`purged ${paths().home}. Start over with: android-lab setup`);
}
