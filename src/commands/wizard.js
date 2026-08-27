// Interactive first run for humans, and a silent one for agents.
//
// Agents get the same code path with --yes: no questions, defaults everywhere,
// and every missing tool either installed or reported with the exact command.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { c, confirm, ok, say, step, warn } from '../log.js';
import {
  ANDROID_ABI, cfg, exe, findJavaHome, hasAccel, osName, paths, run, which,
} from '../platform.js';

// What each tool is called for the package manager of each platform. Anything
// that needs root is printed rather than run: silently sudo-ing on someone's
// machine is not this tool's business.
// How each tool is installed per platform, as a list of commands. Anything
// needing root is only run when root is already granted (see rootIsFree).
//
// apt gets an `update` first: on a machine whose package index is stale, `apt
// install` fails with a 404 on a .deb that no longer exists on the mirror, which
// reads as "the package is gone" rather than "your index is old".
const RECIPES = {
  java: {
    macOS: { cmds: [['brew', 'install', 'openjdk@17']], root: false },
    Linux: { cmds: [['apt-get', 'update'], ['apt-get', 'install', '-y', 'openjdk-17-jdk']], root: true },
    Windows: { cmds: [['winget', 'install', '-e', '--id', 'EclipseAdoptium.Temurin.17.JDK']], root: false },
  },
  scrcpy: {
    macOS: { cmds: [['brew', 'install', 'scrcpy']], root: false },
    Linux: { cmds: [['apt-get', 'update'], ['apt-get', 'install', '-y', 'scrcpy']], root: true },
    Windows: { cmds: [['winget', 'install', '-e', '--id', 'Genymobile.scrcpy']], root: false },
  },
  adb: {
    macOS: { cmds: [['brew', 'install', '--cask', 'android-platform-tools']], root: false },
    Linux: { cmds: [['apt-get', 'update'], ['apt-get', 'install', '-y', 'adb']], root: true },
    Windows: { cmds: [['winget', 'install', '-e', '--id', 'Google.PlatformTools']], root: false },
  },
};

// Root commands are prefixed with sudo unless we already are root.
const asRoot = (cmd) =>
  (typeof process.getuid === 'function' && process.getuid() === 0) ? cmd : ['sudo', ...cmd];

const printableFor = (recipe) =>
  recipe.cmds.map((c) => (recipe.root ? asRoot(c) : c).join(' ')).join(' && ');

// The install command for this platform, so hints never tell a Linux user to run
// brew. Returns null when we have no recipe for the host.
export function installHint(tool) {
  const recipe = RECIPES[tool]?.[osName];
  return recipe ? printableFor(recipe) : null;
}

const present = {
  java: () => Boolean(findJavaHome()),
  scrcpy: () => Boolean(which(exe('scrcpy'))),
  // Either a system adb or the one the SDK download brings along.
  adb: () => Boolean(which(exe('adb')) || existsSync(path.join(paths().sdk, 'platform-tools', exe('adb')))),
};

// True when a root command can run without asking anyone for a password.
export function rootIsFree() {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return true;
  return run('sudo', ['-n', 'true'], { timeout: 5000 }).ok;
}

// Returns the tools still missing after trying. Never throws: scrcpy is optional
// and a failed install should not stop the setup.
export async function ensureTools({ yes = false, want = ['java', 'scrcpy'] } = {}) {
  const missing = want.filter((t) => !present[t]());
  if (!missing.length) return [];

  const stillMissing = [];
  for (const tool of missing) {
    const recipe = RECIPES[tool]?.[osName];
    if (!recipe) {
      warn(`${tool} is missing and I have no install recipe for ${osName}`);
      stillMissing.push(tool);
      continue;
    }
    const printable = printableFor(recipe);

    // Needs root. Running it is only acceptable when root is already granted --
    // we are root, or sudo takes no password. Anywhere else it gets printed,
    // because prompting for a password from inside a tool is how people end up
    // typing secrets into things they did not mean to.
    if (recipe.root && !rootIsFree()) {
      warn(`${tool} is missing. Install it with:\n    ${printable}`);
      stillMissing.push(tool);
      continue;
    }
    const launcher = recipe.cmds[0][0];
    if (!recipe.root && !which(exe(launcher))) {
      warn(`${tool} is missing and so is ${launcher}. Install it with:\n    ${printable}`);
      stillMissing.push(tool);
      continue;
    }
    if (!await confirm(`Install ${tool}?  (${printable})`, { assumeYes: yes })) {
      say(c.dim(`  skipped ${tool} — install it later with: ${printable}`));
      stillMissing.push(tool);
      continue;
    }
    step(printable);
    let failed = false;
    for (const cmd of recipe.cmds) {
      const [bin, ...rest] = recipe.root ? asRoot(cmd) : cmd;
      const r = run(bin, rest, { timeout: 900000, stdio: ['ignore', 'inherit', 'inherit'] });
      if (!r.ok) { failed = true; break; }
    }
    if (!failed && present[tool]()) ok(`${tool} installed`);
    else { warn(`could not install ${tool}. Try by hand:\n    ${printable}`); stillMissing.push(tool); }
  }
  return stillMissing;
}

// Only asks when there is a human on the other end and --yes was not passed.
export async function askSetupOptions({ yes = false } = {}) {
  const defaults = { name: cfg.name, api: cfg.api, start: true };
  if (yes || !process.stdin.isTTY) return defaults;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, def) => (await rl.question(`${c.cyan('?')} ${q} ${c.dim(`[${def}]`)} `)).trim() || def;

  say(c.bold('\n  android-lab setup\n'));
  say(c.dim(`  ${osName} · ${ANDROID_ABI} · ${hasAccel().ok ? 'hardware accelerated' : 'no acceleration'}\n`));
  const name = await ask('Device name', defaults.name);
  const api = await ask('Android API level (33, 34, 35)', defaults.api);
  const start = /^y(es)?$/i.test(await ask('Start it when setup finishes? (y/n)', 'y'));
  rl.close();
  say('');
  return { name, api, start };
}
