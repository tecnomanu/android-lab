// Host diagnosis: which backend can run here, and what is missing for the other.
// The point is that nobody has to guess why something will not start.
import { existsSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { c, info, say } from '../log.js';
import * as emulator from '../backends/emulator.js';
import * as redroid from '../backends/redroid.js';
import { installHint } from './wizard.js';
import {
  ANDROID_ABI, ARCH, exe, findJavaHome, hasAccel, hasBinder, hasDocker,
  isLinux, osName, paths, pickBackend, which,
} from '../platform.js';

const mark = (good) => (good ? c.green('yes') : c.red('no'));

export default async function doctor() {
  say(c.bold('\n  host\n'));
  info('system', `${osName} ${ARCH}`);
  info('node', process.version);
  info('lab home', paths().home);
  try {
    const s = statfsSync(path.dirname(paths().home));
    const free = Math.round((s.bavail * s.bsize) / 1e9);
    info('free space', free < 10 ? c.yellow(`${free} GB — tight, the lab needs ~7 GB`) : `${free} GB`);
  } catch { /* statfs is not available everywhere */ }

  say(c.bold('\n  capabilities\n'));
  const accel = hasAccel();
  info('virtualisation', `${mark(accel.ok)} ${c.dim(accel.how || accel.why)}`);
  const dock = hasDocker();
  info('docker', `${mark(dock.ok)} ${c.dim(dock.engine || dock.why)}`);
  const bind = hasBinder();
  info('binder (kernel)', `${mark(bind.ok)} ${c.dim(bind.how || bind.why)}`);

  say(c.bold('\n  tools\n'));
  const ownAdb = path.join(paths().sdk, 'platform-tools', exe('adb'));
  const adbPath = existsSync(ownAdb) ? ownAdb : which(exe('adb'));
  info('adb', adbPath ? `${mark(true)} ${c.dim(adbPath)}` : `${mark(false)} ${c.dim('missing: android-lab setup')}`);
  const scr = which(exe('scrcpy'));
  info('scrcpy', scr
    ? `${mark(true)} ${c.dim(scr)}`
    : `${c.yellow('no')} ${c.dim(`optional, needed to see the screen: ${installHint('scrcpy') || 'install scrcpy'}`)}`);
  // Checked by running it: macOS ships a /usr/bin/java stub that exists but works.
  const java = findJavaHome();
  info('java', java
    ? `${mark(true)} ${c.dim(java)}`
    : `${c.yellow('no')} ${c.dim(`setup needs a real JDK: ${installHint('java') || 'install a JDK 17+'}`)}`);
  const movicom = process.env.MOVICOM_HOME
    || path.join(process.env.HOME || process.env.USERPROFILE || '', 'movicom');
  info('movicom', existsSync(path.join(movicom, 'movicom.js'))
    ? `${mark(true)} ${c.dim(movicom)}` : c.dim('not installed (optional)'));

  say(c.bold('\n  backends\n'));
  const rows = [
    ['emulator', accel.ok, accel.ok
      ? `ready · ${ANDROID_ABI} image`
      : `would run unaccelerated (very slow): ${accel.why}`],
    ['redroid', dock.ok && bind.ok, dock.ok && bind.ok
      ? 'ready · Android in a container'
      : !dock.ok ? dock.why : bind.why],
  ];
  for (const [n, good, why] of rows) {
    say(`  ${good ? c.green('●') : c.dim('○')} ${c.bold(n.padEnd(9))} ${c.dim(why)}`);
  }
  say(`\n  selected backend: ${c.cyan(pickBackend())}`);

  say(c.bold('\n  devices\n'));
  for (const b of [emulator, redroid]) {
    let st;
    try { st = b.running() ? c.green('running') : b.installed() ? c.dim('installed, stopped') : c.dim('not installed'); }
    catch { st = c.dim('unavailable'); }
    info(b.name, st);
  }

  if (!accel.ok && isLinux && accel.fix) {
    say(`\n  ${c.yellow('fix KVM:')}`);
    for (const cmd of accel.fix) say(`    ${c.dim(cmd)}`);
  }
  if (!bind.ok && isLinux && bind.fix) {
    say(`  ${c.yellow('fix binder:')}`);
    for (const cmd of bind.fix) say(`    ${c.dim(cmd)}`);
  }
  if (!bind.ok && !isLinux) {
    say(`\n  ${c.dim(`redroid does not exist on ${osName}: Docker Desktop runs a LinuxKit kernel with no binder.`)}`);
    say(`  ${c.dim('It is not a permissions or flags problem — the subsystem is not compiled in.')}`);
  }
  say('');
}
