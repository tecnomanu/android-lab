// Every adb call goes through here, and always with an explicit -s <serial>.
// Without it, when a real phone is plugged into the same machine, adb either
// aborts with MULTIPLE_DEVICES or -- worse -- sends the command to the wrong
// device.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { exe, paths, run, which } from './platform.js';

export function adbBin() {
  const own = path.join(paths().sdk, 'platform-tools', exe('adb'));
  if (existsSync(own)) return own;
  const found = which(exe('adb'));
  if (found) return found;
  throw new Error('adb not found. Run `android-lab setup`, or install platform-tools.');
}

export const adb = (args, opts) => run(adbBin(), args, opts);
export const adbOn = (serial, args, opts) => adb(['-s', serial, ...args], opts);
export const shell = (serial, cmdline) => adbOn(serial, ['shell', cmdline]);

export function devices() {
  const r = adb(['devices']);
  if (!r.ok) return [];
  return r.out.split(/\r?\n/).slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter(([s, st]) => s && st === 'device')
    .map(([s]) => s);
}

export const isOnline = (serial) => devices().includes(serial);

// A redroid container speaks adb over TCP; you have to connect before you see it.
export function connect(hostport) {
  const r = adb(['connect', hostport]);
  return r.ok && /connected/i.test(r.out);
}

export const bootCompleted = (serial) =>
  shell(serial, 'getprop sys.boot_completed').out?.trim() === '1';

// The emulator process is up long before Android has finished booting. Reporting
// success there is the classic trap: adb answers while the framework is still
// starting.
export async function waitForBoot(serial, { timeout = 300000, onTick } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (isOnline(serial) && bootCompleted(serial)) {
      shell(serial, 'input keyevent 82'); // dismiss the first-boot lock screen
      return true;
    }
    onTick?.(Math.round((Date.now() - t0) / 1000));
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

// Interactive adb (shell, logcat): inherits the TTY so it behaves like a normal
// terminal, arrow keys and all.
export function adbInteractive(serial, args) {
  return new Promise((resolve) => {
    const p = spawn(adbBin(), ['-s', serial, ...args], { stdio: 'inherit' });
    p.on('close', (code) => resolve(code ?? 0));
    p.on('error', () => resolve(1));
  });
}
