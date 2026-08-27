import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { c, say } from './log.js';
import { cfg, configure, osName, pickBackend } from './platform.js';
import * as emulator from './backends/emulator.js';
import * as redroid from './backends/redroid.js';
import * as remote from './backends/remote.js';
import clean from './commands/clean.js';
import doctor from './commands/doctor.js';
import screen from './commands/screen.js';
import update from './commands/update.js';
import { adbCmd, list, logs, setup, shellCmd, start, status, stop } from './commands/basic.js';

const BACKENDS = { emulator, redroid, remote };
const pkg = JSON.parse(readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));

// Minimal parser. Global options are recognised anywhere, including after
// `shell`/`adb`, because `android-lab shell --name foo ls` is what people
// actually type. Everything after a bare `--` is passed through untouched, which
// is the escape hatch when an inner command needs a flag we would otherwise eat.
const FLAGS_WITH_VALUE = new Set(['backend', 'name', 'out', 'host']);
const BOOL_FLAGS = new Set(['window', 'shot', 'json', 'follow', 'all', 'remove', 'yes', 'y', 'checkOnly', 'help', 'version']);

function parse(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { args._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const [rawKey, inlineValue] = a.slice(2).split('=');
      const key = rawKey.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      if (FLAGS_WITH_VALUE.has(key)) {
        args[key] = inlineValue !== undefined ? inlineValue : argv[++i];
        continue;
      }
      if (BOOL_FLAGS.has(key)) {
        args[key] = inlineValue !== undefined ? inlineValue !== 'false' : true;
        continue;
      }
    }
    args._.push(a); // unknown flags belong to the inner command
  }
  return args;
}

const HELP = () => `
  ${c.bold('android-lab')} ${c.dim(`v${pkg.version}`)} — a virtual Android you can drive from ADB, Movicom and agents

  ${c.bold('usage')}
    android-lab <command> [options]

  ${c.bold('commands')}
    ${c.cyan('doctor')}              what can run on this machine, and what is missing
    ${c.cyan('setup')}               install the backend and create the device
    ${c.cyan('start')}   [--window]  boot it, waiting for the real boot to finish
    ${c.cyan('stop')}                clean shutdown, never wipes data
    ${c.cyan('status')}  [--json]    state, version, visible devices
    ${c.cyan('list')}    [--json]    every device you have created
    ${c.cyan('screen')}  [--shot]    view and drive it (scrcpy), or take one screenshot
    ${c.cyan('shell')}   [cmd...]    a terminal inside Android
    ${c.cyan('adb')}     <args...>   raw adb, already pinned to this device
    ${c.cyan('logs')}    [--follow]  backend log
    ${c.cyan('update')}  [--check-only]
                        update SDK packages or the container image, and check npm
    ${c.cyan('clean')}   [--remove | --all]
                        factory reset · delete the device · delete everything

  ${c.bold('options')}
    --name <name>                  which device (default: apx-android)
    --host <host[:port]>           drive a device on another machine over adb
    --backend <emulator|redroid>   force a backend (default: automatic)
    --json                          machine-readable output
    --yes                           no questions: assume yes (setup, clean)
    --help, --version

  ${c.bold('several at once')}
    Every command takes --name, so you can run more than one device side by side.
    Ports and serials are allocated automatically and remembered.

      android-lab setup --name pixel && android-lab start --name pixel
      android-lab shell --name pixel
      android-lab list

  ${c.bold('another machine')}
    A device running elsewhere is driven over adb's TCP transport. Nothing is
    installed locally -- the SDK and the RAM stay on its host.

      android-lab status --host 192.168.1.10:5555
      android-lab shell  --host 192.168.1.10:5555

    adb over TCP is unauthenticated, so keep it off untrusted networks: bind it
    to Tailscale, or tunnel it with
    ${c.dim('ssh -L 5555:localhost:5555 user@host')} and use ${c.dim('--host localhost:5555')}.

  ${c.bold('backends')}
    ${c.bold('emulator')}  Native Android Emulator. macOS, Linux and Windows.
    ${c.bold('redroid')}   Android in a Docker container. Native Linux only (it needs
              binder in the host kernel).
    Picked automatically; ${c.dim('android-lab doctor')} tells you why.

  ${c.bold('environment')}
    ANDROID_LAB_HOME     where everything lives (default: ~/.android-lab)
    ANDROID_LAB_BACKEND  default backend
    ANDROID_LAB_NAME     default device name
    ANDROID_API, SYSTEM_IMAGE, EMU_SERIAL, REDROID_IMAGE, REDROID_PORT
    MOVICOM_HOME         default: ~/movicom

  ${c.dim(`running on ${osName}`)}
`;

export async function main(argv) {
  const args = parse(argv);
  const cmd = args._[0];

  if (args.version) return say(pkg.version);
  if (!cmd || args.help || cmd === 'help') return say(HELP());

  if (args.backend && !BACKENDS[args.backend]) {
    throw new Error(`unknown backend: ${args.backend}. Available: ${Object.keys(BACKENDS).join(', ')}`);
  }
  configure({ name: args.name, host: args.host });
  const be = BACKENDS[pickBackend(args.backend)];

  switch (cmd) {
    case 'doctor':  return doctor();
    case 'setup':
    case 'install': return setup(be, args);   // `install` is the obvious guess; keep it working
    case 'start':   return start(be, args);
    case 'stop':    return stop(be);
    case 'status':  return status(be, args);
    case 'list':
    case 'ls':      return list(be, args);
    case 'screen':  return screen(be, args);
    case 'shell':   return shellCmd(be, args);
    case 'adb':     return adbCmd(be, args);
    case 'logs':    return logs(be, args);
    case 'update':  return update(be, args);
    case 'clean':   return clean(be, args);
    default:
      throw new Error(`unknown command: ${cmd}\n${HELP()}`);
  }
}
