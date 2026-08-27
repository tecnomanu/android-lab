// Interactive first run for humans, and a silent one for agents.
//
// Agents get the same code path with --yes: no questions, defaults everywhere,
// and every missing tool either installed or reported with the exact command.
import { createInterface } from 'node:readline/promises';
import { c, confirm, ok, say, step, warn } from '../log.js';
import {
  ANDROID_ABI, cfg, configure, exe, findJavaHome, hasAccel, isLinux, isMac, isWin,
  osName, run, which,
} from '../platform.js';

// What each tool is called for the package manager of each platform. Anything
// that needs root is printed rather than run: silently sudo-ing on someone's
// machine is not this tool's business.
const RECIPES = {
  java: {
    macOS: { cmd: ['brew', 'install', 'openjdk@17'], root: false },
    Linux: { cmd: ['sudo', 'apt', 'install', '-y', 'openjdk-17-jdk'], root: true },
    Windows: { cmd: ['winget', 'install', '-e', '--id', 'EclipseAdoptium.Temurin.17.JDK'], root: false },
  },
  scrcpy: {
    macOS: { cmd: ['brew', 'install', 'scrcpy'], root: false },
    Linux: { cmd: ['sudo', 'apt', 'install', '-y', 'scrcpy'], root: true },
    Windows: { cmd: ['winget', 'install', '-e', '--id', 'Genymobile.scrcpy'], root: false },
  },
};

const present = {
  java: () => Boolean(findJavaHome()),
  scrcpy: () => Boolean(which(exe('scrcpy'))),
};

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
    const printable = recipe.cmd.join(' ');

    if (recipe.root) {
      // Needs root: print it, never run it unattended.
      warn(`${tool} is missing. Install it with:\n    ${printable}`);
      stillMissing.push(tool);
      continue;
    }
    if (!which(exe(recipe.cmd[0]))) {
      warn(`${tool} is missing and so is ${recipe.cmd[0]}. Install it with:\n    ${printable}`);
      stillMissing.push(tool);
      continue;
    }
    if (!await confirm(`Install ${tool}?  (${printable})`, { assumeYes: yes })) {
      say(c.dim(`  skipped ${tool} — install it later with: ${printable}`));
      stillMissing.push(tool);
      continue;
    }
    step(printable);
    const r = run(recipe.cmd[0], recipe.cmd.slice(1),
      { timeout: 900000, stdio: ['ignore', 'inherit', 'inherit'] });
    if (r.ok && present[tool]()) ok(`${tool} installed`);
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
