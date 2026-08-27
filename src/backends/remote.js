// A device running on another machine, reached over adb's TCP transport.
//
// Nothing is installed locally: adb speaks to the remote device directly, so the
// 5 GB of SDK and the RAM stay on the host. This backend only drives a device --
// creating, starting and deleting one has to happen where it lives.
import { adb, adbOn, connect, devices, shell } from '../adb.js';
import { cfg, run } from '../platform.js';
import { c, say } from '../log.js';

export const name = 'remote';
export const requires = ['adb'];

// --host accepts "host" or "host:port"; adb's default TCP port is 5555.
export function endpoint() {
  const raw = cfg.host || process.env.ANDROID_LAB_HOST || '';
  if (!raw) throw new Error('the remote backend needs --host <host[:port]>');
  return raw.includes(':') ? raw : `${raw}:5555`;
}

export const serial = () => endpoint();

export function running() {
  const s = endpoint();
  if (devices().includes(s)) return true;
  return connect(s) && devices().includes(s);
}

export const installed = () => true;   // it exists on the other machine or it does not
export const discover = () => [];      // nothing to enumerate locally

const elsewhere = (verb) => {
  throw new Error(
    `\`${verb}\` has to run on the machine hosting the device.\n` +
    `  There:  android-lab ${verb}\n` +
    `  Here:   android-lab status --host ${cfg.host || '<host>'}`);
};

export const setup = async () => elsewhere('setup');
export const start = async () => elsewhere('start');
export const wipe = () => elsewhere('clean');
export const destroy = () => elsewhere('clean --remove');

// Only drops the local connection; the device keeps running where it lives.
export async function stop() {
  const s = endpoint();
  if (!devices().includes(s)) return false;
  adb(['disconnect', s]);
  say(c.dim('disconnected. The device keeps running on its host.'));
  return true;
}

export function info() {
  const s = endpoint();
  const up = running();
  return {
    backend: name, name: s, serial: s, running: up, installed: true,
    model: up ? shell(s, 'getprop ro.product.model').out?.trim() : undefined,
    release: up ? shell(s, 'getprop ro.build.version.release').out?.trim() : undefined,
    sdk: up ? shell(s, 'getprop ro.build.version.sdk').out?.trim() : undefined,
    boot: up ? shell(s, 'getprop sys.boot_completed').out?.trim() : undefined,
    host: s,
  };
}
