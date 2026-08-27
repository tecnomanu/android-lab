// Native Android Emulator backend. The only one that runs on all three systems:
// it uses Hypervisor.framework (macOS), KVM (Linux) or WHPX (Windows).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { adb, adbOn, devices, shell, waitForBoot } from '../adb.js';
import { ANDROID_ABI, bat, cfg, exe, findJavaHome, hasAccel, isMac, isWin, osName, paths, run, which } from '../platform.js';
import { getInstance, listInstances, removeInstance, setInstance } from '../state.js';
import { c, say, spinner, step, warn } from '../log.js';

export const name = 'emulator';
// sdkmanager and avdmanager are java wrappers; adb arrives with platform-tools.
export const requires = ['java'];

const emuBin = () => path.join(paths().sdk, 'emulator', exe('emulator'));
const sdkTool = (n) => path.join(paths().sdk, 'cmdline-tools', 'latest', 'bin', bat(n));
const avdDir = () => path.join(paths().avd, `${cfg.name}.avd`);

const env = () => {
  const java = findJavaHome();
  return {
    ...process.env,
    ANDROID_SDK_ROOT: paths().sdk,
    ANDROID_HOME: paths().sdk,
    ANDROID_AVD_HOME: paths().avd,
    // sdkmanager and avdmanager are shell wrappers around java; without a real
    // JAVA_HOME they fail with a message that never mentions java.
    ...(java ? { JAVA_HOME: java, PATH: `${path.join(java, 'bin')}${isWin ? ';' : ':'}${process.env.PATH}` } : {}),
  };
};

// Ask a live emulator which AVD it is running. This is the ground truth: the
// state file is only a cache, and a device started by other means (or before this
// CLI existed) would otherwise be invisible.
export function avdNameOf(s) {
  const r = adbOn(s, ['emu', 'avd', 'name']);
  return r.ok ? r.out.split(/\r?\n/)[0].trim() : null;
}

// Each running emulator owns an even console port; the serial derives from it.
// Resolution order: explicit env > a live emulator actually running this AVD >
// what we recorded > the default port.
export function serial() {
  if (process.env.EMU_SERIAL) return process.env.EMU_SERIAL;
  for (const d of devices().filter((x) => x.startsWith('emulator-'))) {
    if (avdNameOf(d) === cfg.name) return d;
  }
  return getInstance(cfg.name)?.serial || 'emulator-5554';
}

// Every AVD on disk, whether this CLI created it or not.
export function discover() {
  try {
    return readdirSync(paths().avd)
      .filter((f) => f.endsWith('.avd'))
      .map((f) => f.slice(0, -4));
  } catch { return []; }
}

function allocPort() {
  // A device restarting reclaims the port it had; only *other* devices reserve one.
  const own = getInstance(cfg.name)?.port;
  const reserved = new Set(listInstances()
    .filter((i) => i.name !== cfg.name)
    .map((i) => i.port)
    .filter(Boolean));
  const live = new Set(devices()
    .filter((d) => d.startsWith('emulator-'))
    .map((d) => Number(d.split('-')[1])));
  if (own && !reserved.has(own) && !live.has(own)) return own;
  for (let p = 5554; p <= 5682; p += 2) {
    if (!reserved.has(p) && !live.has(p)) return p;
  }
  throw new Error('no free emulator console ports left (5554-5682)');
}

export const installed = () => existsSync(emuBin()) && existsSync(avdDir());

// Identity comes from the AVD name, never from the port. Two devices are alive at
// once, and the default serial would otherwise make a stopped device look like it
// is running just because some other emulator holds 5554.
export const running = () => devices()
  .filter((d) => d.startsWith('emulator-'))
  .some((d) => avdNameOf(d) === cfg.name);

export async function setup({ log = step } = {}) {
  const p = paths();
  for (const d of [p.home, p.sdk, p.avd, p.logs]) mkdirSync(d, { recursive: true });

  const accel = hasAccel();
  if (!accel.ok) warn(`no hardware acceleration: ${accel.why}. It will run, but slowly.`);

  if (!findJavaHome()) {
    throw new Error(
      'no working Java runtime found — sdkmanager and avdmanager are java wrappers.\n' +
      (osName === 'macOS' ? '    brew install openjdk@17' :
       osName === 'Linux' ? '    sudo apt install openjdk-17-jdk' :
       '    winget install EclipseAdoptium.Temurin.17.JDK') +
      '\n  If you already have one, point JAVA_HOME at it.');
  }

  if (!existsSync(sdkTool('sdkmanager'))) {
    log('fetching the Android command-line tools');
    await fetchCmdlineTools();
  }
  const clt = sdkTool('sdkmanager');
  if (!existsSync(clt)) {
    throw new Error(
      `Android command-line tools are still missing from ${path.join(paths().sdk, 'cmdline-tools', 'latest')}.\n` +
      '  Download them by hand from https://developer.android.com/studio#command-line-tools-only\n' +
      `  and unzip so that ${path.join(paths().sdk, 'cmdline-tools', 'latest', 'bin')} exists.`);
  }

  log('accepting SDK licences');
  run(clt, [`--sdk_root=${paths().sdk}`, '--licenses'],
    { input: 'y\n'.repeat(50), env: env(), timeout: 300000 });

  log(`downloading emulator + ${ANDROID_ABI} system image (~5 GB, takes a while)`);
  // Still answering y: a package can carry its own licence that the blanket
  // --licenses pass did not cover, and an unanswered prompt silently skips it.
  const dl = run(clt, [`--sdk_root=${paths().sdk}`, 'platform-tools', 'emulator', cfg.systemImage],
    { input: 'y\n'.repeat(50), env: env(), timeout: 3600000, stdio: ['pipe', 'inherit', 'inherit'] });
  if (!dl.ok) throw new Error(`SDK download failed: ${dl.out?.slice(-400)}`);

  if (run(emuBin(), ['-list-avds'], { env: env() }).out.split(/\r?\n/).includes(cfg.name)) {
    log(`AVD ${cfg.name} already exists, leaving it alone`);
    return;
  }

  log(`creating AVD ${cfg.name}`);
  const cr = run(sdkTool('avdmanager'),
    ['create', 'avd', '--name', cfg.name, '--package', cfg.systemImage,
     '--device', 'pixel_6', '--path', avdDir()],
    { input: 'no\n', env: env(), timeout: 180000 });

  const ini = path.join(avdDir(), 'config.ini');
  if (!existsSync(ini)) throw new Error(`could not create the AVD: ${cr.out?.slice(-400)}`);
  tuneAvd(ini);
}

// No distro packages these usefully -- Ubuntu's android-sdk does not ship
// cmdline-tools/latest, and Homebrew's cask is macOS only -- so we fetch the zip
// Google publishes. Pin a different build with CMDLINE_TOOLS_URL.
const CMDLINE_TOOLS_BUILD = process.env.CMDLINE_TOOLS_BUILD || '11076708';
const cmdlineToolsUrl = () => {
  if (process.env.CMDLINE_TOOLS_URL) return process.env.CMDLINE_TOOLS_URL;
  const os = isMac ? 'mac' : isWin ? 'win' : 'linux';
  return `https://dl.google.com/android/repository/commandlinetools-${os}-${CMDLINE_TOOLS_BUILD}_latest.zip`;
};

async function fetchCmdlineTools() {
  const url = cmdlineToolsUrl();
  const tmp = path.join(paths().sdk, `cmdline-tools-${CMDLINE_TOOLS_BUILD}.zip`);
  const stage = path.join(paths().sdk, 'cmdline-tools-stage');

  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not download the command-line tools (${res.status}) from ${url}`);
  writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));

  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  if (!unzip(tmp, stage)) {
    rmSync(tmp, { force: true });
    throw new Error(
      'downloaded the command-line tools but could not unzip them.\n' +
      (isWin ? '  Install PowerShell 5+ or unzip the archive by hand.'
             : '  Install `unzip` (sudo apt install -y unzip) and run setup again.'));
  }

  // The archive expands to cmdline-tools/, but sdkmanager insists on living in a
  // versioned directory -- "latest" is the convention it accepts.
  const dest = path.join(paths().sdk, 'cmdline-tools', 'latest');
  mkdirSync(path.dirname(dest), { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  renameSync(path.join(stage, 'cmdline-tools'), dest);
  rmSync(stage, { recursive: true, force: true });
  rmSync(tmp, { force: true });
}

// No zip support in Node, so borrow whatever the host has. bsdtar (macOS `tar`)
// reads zips; GNU tar does not, which is why `unzip` comes first on Linux.
function unzip(zip, dest) {
  const attempts = isWin
    ? [['powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`]]]
    : [['unzip', ['-q', '-o', zip, '-d', dest]], ['tar', ['-xf', zip, '-C', dest]]];
  for (const [bin, args] of attempts) {
    if (!isWin && !which(bin)) continue;
    if (run(bin, args, { timeout: 300000 }).ok) return true;
  }
  return false;
}

// Only the settings that actually matter; everything else keeps the AVD default.
function tuneAvd(ini) {
  const want = {
    'hw.keyboard': 'yes',                    // without this, text sent over adb arrives mangled
    'hw.ramSize': '4096',
    'vm.heapSize': '512M',
    'hw.cpu.ncore': '6',
    'hw.gpu.enabled': 'yes',
    'hw.gpu.mode': 'swiftshader_indirect',   // software rendering: works headless and windowed
    'fastboot.forceColdBoot': 'yes',         // no snapshots: persistence comes from userdata
    'fastboot.forceFastBoot': 'no',
    'firstboot.bootFromDownloadableSnapshot': 'no',
    'firstboot.bootFromLocalSnapshot': 'no',
    'firstboot.saveToLocalSnapshot': 'no',
  };
  const lines = readFileSync(ini, 'utf8').split(/\r?\n/);
  for (const [k, v] of Object.entries(want)) {
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = `${k}=${v}`; else lines.push(`${k}=${v}`);
  }
  writeFileSync(ini, lines.filter(Boolean).join('\n') + '\n');
}

export async function start({ window: withWindow = false } = {}) {
  if (running()) return serial();
  if (!installed()) throw new Error(`"${cfg.name}" is not installed yet. Run: android-lab setup --name ${cfg.name}`);

  mkdirSync(paths().logs, { recursive: true });
  const logFile = path.join(paths().logs, `${cfg.name}.log`);
  const fd = openSync(logFile, 'a');

  const port = process.env.EMU_SERIAL ? Number(process.env.EMU_SERIAL.split('-')[1]) : allocPort();
  const args = [
    '-avd', cfg.name, '-port', String(port),
    '-no-boot-anim', '-no-audio', '-no-snapshot',
    ...(withWindow ? [] : ['-no-window']),
  ];
  // detached + unref: the emulator outlives the terminal that started it.
  const child = spawn(emuBin(), args, {
    detached: true, stdio: ['ignore', fd, fd], env: env(), windowsHide: !withWindow,
  });
  child.unref();

  const s = `emulator-${port}`;
  setInstance(cfg.name, { backend: name, serial: s, port, pid: child.pid, logFile });

  say(`${c.dim('pid')} ${child.pid}  ${c.dim('port')} ${port}  ${c.dim('log')} ${logFile}`);
  const sp = spinner('waiting for sys.boot_completed');
  const booted = await waitForBoot(s, { onTick: (n) => sp.update(`waiting for sys.boot_completed (${n}s)`) });
  sp.stop();
  if (!booted) throw new Error(`it never finished booting. Check ${logFile}`);
  return s;
}

export async function stop() {
  if (!running()) return false;
  const s = serial();
  shell(s, 'sync');                 // flush to disk before pulling the plug
  adbOn(s, ['emu', 'kill']);        // clean shutdown, never -wipe-data
  for (let i = 0; i < 30 && running(); i++) await new Promise((r) => setTimeout(r, 1000));
  return true;
}

// Factory reset: drops userdata so the device comes back as if freshly created.
export function wipe() {
  for (const f of ['userdata-qemu.img', 'userdata-qemu.img.qcow2', 'userdata.img', 'cache.img']) {
    rmSync(path.join(avdDir(), f), { force: true });
  }
}

// Removes the device itself, but never the downloaded SDK.
export function destroy() {
  rmSync(avdDir(), { recursive: true, force: true });
  rmSync(path.join(paths().avd, `${cfg.name}.ini`), { force: true });
  removeInstance(cfg.name);
}

export function info() {
  const s = serial();
  const up = running();
  return {
    backend: name, name: cfg.name, serial: s, running: up,
    model: up ? shell(s, 'getprop ro.product.model').out?.trim() : undefined,
    release: up ? shell(s, 'getprop ro.build.version.release').out?.trim() : undefined,
    sdk: up ? shell(s, 'getprop ro.build.version.sdk').out?.trim() : undefined,
    boot: up ? shell(s, 'getprop sys.boot_completed').out?.trim() : undefined,
    avd: cfg.name,
    installed: installed(),
    logFile: path.join(paths().logs, `${cfg.name}.log`),
  };
}
