// See and drive the screen. scrcpy works the same against a headless emulator and
// a redroid container: both speak adb, which is all it cares about.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { adbOn } from '../adb.js';
import { c, ok, say } from '../log.js';
import { cfg, exe, osName, paths, which } from '../platform.js';
import { requireRunning } from './basic.js';

export default async function screen(be, args) {
  requireRunning(be);
  const serial = be.serial();

  if (args.shot) {
    mkdirSync(paths().logs, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const out = args.out || path.join(paths().logs, `${cfg.name}-${stamp}.png`);
    const r = adbOn(serial, ['exec-out', 'screencap', '-p'],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    if (!r.ok) throw new Error('could not capture the screen');
    writeFileSync(out, r.out);
    return ok(`screenshot -> ${out}`);
  }

  if (!which(exe('scrcpy'))) {
    throw new Error(
      'scrcpy is missing (it is what shows the screen).\n' +
      (osName === 'macOS' ? '  brew install scrcpy' :
       osName === 'Linux' ? '  sudo apt install scrcpy   (or: snap install scrcpy)' :
       '  winget install Genymobile.scrcpy   (or: choco install scrcpy)') +
      '\n  Meanwhile, a single screenshot:  android-lab screen --shot');
  }

  say(c.dim(`opening scrcpy on ${serial} — close the window or press Ctrl-C to exit\n`));
  const p = spawn(exe('scrcpy'),
    ['-s', serial, '--no-audio', '--window-title', `android-lab (${cfg.name})`],
    { stdio: 'inherit' });
  await new Promise((res) => { p.on('close', res); p.on('error', res); });
}
