// setup / start / stop / status / list / shell / adb / logs
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { adbInteractive, devices, shell as adbShell } from '../adb.js';
import { c, info, ok, say, step, warn } from '../log.js';
import { cfg, configure, exe, paths, run } from '../platform.js';
import * as emulator from '../backends/emulator.js';
import * as redroid from '../backends/redroid.js';

const BACKENDS = { emulator, redroid };
import { listInstances } from '../state.js';
import { askSetupOptions, ensureTools, installHint } from './wizard.js';

export async function setup(be, args) {
  const yes = Boolean(args.yes || args.y);
  const opts = await askSetupOptions({ yes });
  configure({ name: args.name || opts.name, api: opts.api });

  // Only what this backend actually needs: redroid has no SDK and no java, it
  // just needs an adb on the host to reach the container. Handled before the long
  // download, so nobody waits five minutes to fail on a missing tool at the end.
  const needed = be.requires ?? [];
  const missing = await ensureTools({ yes, want: [...needed, 'scrcpy'] });
  const blocking = needed.filter((t) => missing.includes(t));
  if (blocking.length) {
    throw new Error(
      `the ${be.name} backend needs ${blocking.join(' and ')}, still missing.\n` +
      blocking.map((t) => `    ${installHint(t) || t}`).join('\n') +
      '\n  Install and run setup again.');
  }

  step(`installing the ${c.bold(be.name)} backend into ${paths().home}`);
  await be.setup({});

  const suffix = cfg.name === 'apx-android' ? '' : ` --name ${cfg.name}`;
  if (opts.start) {
    return start(be, { ...args, name: cfg.name });
  }
  ok(`done. Start it with:  android-lab start${suffix}`);
}

export async function start(be, args) {
  if (be.running()) {
    ok(`"${cfg.name}" was already running (${be.serial()})`);
  } else {
    await be.start({ window: args.window });
  }
  const i = be.info();
  say('');
  info('name', i.name);
  info('backend', i.backend);
  info('serial', i.serial);
  info('model', i.model || '?');
  info('android', `${i.release || '?'} (API ${i.sdk || '?'})`);
  info('boot_completed', i.boot === '1' ? c.green('1') : c.red(i.boot || '0'));

  const movi = movicomPath();
  if (movi) {
    const r = run(exe('node'), [movi, 'devices'], { timeout: 20000 });
    info('movicom', r.ok && r.out.includes(i.serial)
      ? `${c.green('sees it')} ${c.dim(r.out.slice(0, 70))}`
      : c.dim(r.out?.slice(0, 70) || 'no output'));
  }
  say(`\n  ${c.dim('view:')} android-lab screen    ${c.dim('terminal:')} android-lab shell`);
}

export async function stop(be) {
  ok(await be.stop() ? 'stopped cleanly (no data wiped)' : 'it was not running');
}

export async function status(be, args) {
  const i = be.info();
  if (args.json) return say(JSON.stringify({ ...i, devices: devices() }, null, 2));
  say('');
  info('name', i.name);
  info('backend', i.backend);
  info('state', i.running ? c.green('running') : i.installed ? c.dim('stopped') : c.dim('not installed'));
  if (i.running) {
    info('serial', i.serial);
    info('model', i.model || '?');
    info('android', `${i.release || '?'} (API ${i.sdk || '?'})`);
    info('boot_completed', i.boot === '1' ? c.green('1') : c.red(i.boot || '0'));
  }
  if (i.container) info('container', `${i.container} ${c.dim(i.image)}`);
  warnIfCrowded();
  say('');
}

// Merges what we recorded with what is actually on disk and running, so a device
// created by other means still shows up instead of silently going missing.
export async function list(be, args) {
  const recorded = new Map(listInstances().map((i) => [i.name, i]));
  const rows = new Map();

  for (const [backendName, mod] of Object.entries(BACKENDS)) {
    for (const name of mod.discover?.() ?? []) {
      rows.set(name, { name, backend: backendName, ...recorded.get(name) });
    }
  }
  for (const [name, i] of recorded) if (!rows.has(name)) rows.set(name, i);

  const out = [...rows.values()].map((i) => {
    // Resolve the serial through the backend so a running device reports the
    // port it actually got, not the one we last wrote down.
    const prev = cfg.name;
    configure({ name: i.name });
    const mod = BACKENDS[i.backend] ?? be;
    let serial = i.serial;
    let running = false;
    try { running = mod.running(); serial = running ? mod.serial() : i.serial; }
    catch { /* backend unavailable on this host */ }
    configure({ name: prev });
    return { ...i, serial, running };
  });

  if (args.json) return say(JSON.stringify(out, null, 2));
  if (!out.length) return say(`\n  ${c.dim('no devices yet. Create one with:')} android-lab setup\n`);

  say('');
  say(`  ${c.dim('NAME'.padEnd(20))}${c.dim('BACKEND'.padEnd(11))}${c.dim('SERIAL'.padEnd(20))}STATE`);
  for (const i of out) {
    say(`  ${i.name.padEnd(20)}${(i.backend || '?').padEnd(11)}${(i.serial || '?').padEnd(20)}` +
        (i.running ? c.green('running') : c.dim('stopped')));
  }
  warnIfCrowded();
  say('');
}

// Terminal inside Android, be it an emulator or a container.
export async function shellCmd(be, args) {
  requireRunning(be);
  const rest = args._.slice(1);
  if (rest.length === 0) {
    say(c.dim(`shell on ${be.serial()} — leave with exit or Ctrl-D\n`));
    process.exit(await adbInteractive(be.serial(), ['shell']));
  }
  const r = adbShell(be.serial(), rest.join(' '));
  if (r.out) say(r.out);
  process.exit(r.ok ? 0 : r.code ?? 1);
}

export async function adbCmd(be, args) {
  process.exit(await adbInteractive(be.serial(), args._.slice(1)));
}

export async function logs(be, args) {
  if (be.name === 'redroid') {
    process.exit(await passthrough(exe('docker'),
      [...(args.follow ? ['logs', '-f'] : ['logs']), cfg.name]));
  }
  const f = be.info().logFile;
  if (!existsSync(f)) return warn(`no log at ${f} yet`);
  process.exit(await passthrough('tail', [...(args.follow ? ['-f'] : ['-n', '200']), f]));
}

function passthrough(cmd, argv) {
  return new Promise((res) => {
    const p = spawn(cmd, argv, { stdio: 'inherit' });
    p.on('close', (code) => res(code ?? 0));
    p.on('error', () => res(1));
  });
}

function warnIfCrowded() {
  const all = devices();
  if (all.length > 1) {
    say(`\n  ${c.yellow('note:')} adb can see ${all.length} devices: ${all.join(', ')}`);
    say(`  ${c.dim('This CLI always pins -s, but a bare adb command can hit the wrong one.')}`);
  }
}

export function requireRunning(be) {
  if (!be.running()) {
    throw new Error(`"${cfg.name}" is not running. Start it with:  android-lab start` +
      (cfg.name === 'apx-android' ? '' : ` --name ${cfg.name}`));
  }
}

export function movicomPath() {
  const home = process.env.MOVICOM_HOME
    || path.join(process.env.HOME || process.env.USERPROFILE || '', 'movicom');
  const js = path.join(home, 'movicom.js');
  return existsSync(js) ? js : null;
}
