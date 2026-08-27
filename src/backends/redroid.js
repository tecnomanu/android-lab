// redroid backend: Android as a Docker container, with no emulation at all.
// The Android system runs straight on the host kernel, so it boots in seconds and
// stays small. The price is that it needs binder in the HOST kernel, and today
// that only exists on native Linux. See doctor.js.
import { mkdirSync, rmSync } from 'node:fs';
import { connect, shell, waitForBoot } from '../adb.js';
import { cfg, exe, hasBinder, hasDocker, paths, run } from '../platform.js';
import { getInstance, listInstances, removeInstance, setInstance } from '../state.js';
import { say, spinner, step } from '../log.js';

export const name = 'redroid';
// No SDK and no java here: the container is the whole system. But the host still
// needs adb, because the only way in is `adb connect` over TCP.
export const requires = ['adb'];

const docker = (args, opts) => run(exe('docker'), args, opts);
const dataDir = () => `${paths().redroidData}/${cfg.name}`;

export function serial() {
  const known = getInstance(cfg.name);
  return `127.0.0.1:${known?.port || process.env.REDROID_PORT || 5555}`;
}

function allocPort() {
  const reserved = new Set(listInstances().map((i) => i.port).filter(Boolean));
  for (let p = 5555; p <= 5600; p++) if (!reserved.has(p)) return p;
  throw new Error('no free redroid ports left (5555-5600)');
}

// Every redroid container on this host, whether this CLI created it or not.
export function discover() {
  const r = docker(['ps', '-a', '--format', '{{.Names}}\t{{.Image}}']);
  if (!r.ok) return [];
  return r.out.split(/\r?\n/)
    .filter((l) => /redroid/i.test(l))
    .map((l) => l.split('\t')[0])
    .filter(Boolean);
}

const containerState = () => {
  const r = docker(['inspect', '-f', '{{.State.Status}}', cfg.name]);
  return r.ok ? r.out.trim() : null; // null = does not exist
};

export const installed = () => containerState() !== null;
export const running = () => containerState() === 'running';

function requireHost() {
  const d = hasDocker();
  if (!d.ok) throw new Error(`redroid needs Docker: ${d.why}`);
  const b = hasBinder();
  if (!b.ok) {
    throw new Error(
      `redroid cannot run on this host: ${b.why}.\n` +
      '  Use the emulator backend instead:  android-lab start --backend emulator');
  }
}

export async function setup({ log = step } = {}) {
  requireHost();
  mkdirSync(dataDir(), { recursive: true });
  mkdirSync(paths().logs, { recursive: true });
  log(`pulling ${cfg.redroidImage}`);
  const r = docker(['pull', cfg.redroidImage],
    { timeout: 1800000, stdio: ['ignore', 'inherit', 'inherit'] });
  if (!r.ok) throw new Error(`could not pull the image: ${r.out?.slice(-300)}`);
}

export async function start() {
  if (running()) return serial();
  requireHost();
  mkdirSync(dataDir(), { recursive: true });

  let port = getInstance(cfg.name)?.port;
  if (containerState()) {
    step('resuming the container');
    const r = docker(['start', cfg.name]);
    if (!r.ok) throw new Error(`the container did not start: ${r.out}`);
  } else {
    port = Number(process.env.REDROID_PORT) || allocPort();
    step(`creating container ${cfg.name} on port ${port}`);
    // --privileged is what grants access to binder/ashmem. Mounting /data from
    // the host is what makes state survive deleting the container.
    const r = docker([
      'run', '-d', '--name', cfg.name, '--privileged',
      '-v', `${dataDir()}:/data`,
      '-p', `${port}:5555`,
      cfg.redroidImage,
      'androidboot.redroid_width=1080',
      'androidboot.redroid_height=1920',
      'androidboot.redroid_dpi=440',
      'androidboot.redroid_gpu_mode=guest', // software rendering: assumes no host GPU
    ], { timeout: 120000 });
    if (!r.ok) throw new Error(`the container did not start: ${r.out?.slice(-400)}`);
  }

  setInstance(cfg.name, { backend: name, serial: `127.0.0.1:${port}`, port, image: cfg.redroidImage });

  const sp = spinner('waiting for sys.boot_completed');
  for (let i = 0; i < 30 && !connect(serial()); i++) await new Promise((r) => setTimeout(r, 1000));
  const booted = await waitForBoot(serial(), { onTick: (n) => sp.update(`waiting for sys.boot_completed (${n}s)`) });
  sp.stop();
  if (!booted) throw new Error(`it never finished booting. Check: docker logs ${cfg.name}`);
  return serial();
}

export async function stop() {
  if (!running()) return false;
  shell(serial(), 'sync');
  return docker(['stop', cfg.name], { timeout: 60000 }).ok;
}

// Factory reset: the container is disposable, the state lives in the volume.
export function wipe() {
  rmSync(dataDir(), { recursive: true, force: true });
  mkdirSync(dataDir(), { recursive: true });
}

export function destroy() {
  docker(['rm', '-f', cfg.name], { timeout: 60000 });
  rmSync(dataDir(), { recursive: true, force: true });
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
    container: cfg.name,
    image: cfg.redroidImage,
    installed: installed(),
    dataDir: dataDir(),
  };
}
