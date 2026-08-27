// Platform and capability detection. Everything is probed at runtime: checking
// process.platform is not enough, because what decides whether a backend can run
// is the kernel underneath (KVM, binder, Hypervisor.framework), not the OS name.
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const OS = process.platform; // 'darwin' | 'linux' | 'win32'
export const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
export const isWin = OS === 'win32';
export const isMac = OS === 'darwin';
export const isLinux = OS === 'linux';

export const osName = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }[OS] || OS;

// The system image has to match the host CPU. An arm64 guest on x86 (or the
// other way round) falls back to QEMU emulation and is unusably slow.
export const ANDROID_ABI = ARCH === 'arm64' ? 'arm64-v8a' : 'x86_64';

// Where the heavy stuff lives. ANDROID_LAB_HOME moves it, which is how you keep
// ~6 GB off a full boot drive.
export function labHome() {
  return process.env.ANDROID_LAB_HOME || path.join(homedir(), '.android-lab');
}

export const paths = () => {
  const home = labHome();
  return {
    home,
    sdk: path.join(home, 'sdk'),
    avd: path.join(home, 'avd'),
    logs: path.join(home, 'logs'),
    redroidData: path.join(home, 'redroid-data'),
    state: path.join(home, 'state.json'),
  };
};

// One name identifies a device across both backends: it is the AVD name for the
// emulator and the container name for redroid.
export const cfg = {
  name: process.env.ANDROID_LAB_NAME || 'apx-android',
  api: process.env.ANDROID_API || '35',
  get systemImage() {
    return process.env.SYSTEM_IMAGE || `system-images;android-${this.api};google_apis;${ANDROID_ABI}`;
  },
  redroidImage: process.env.REDROID_IMAGE || 'redroid/redroid:14.0.0-latest',
};

export function configure({ name, api } = {}) {
  if (name) cfg.name = name;
  if (api) cfg.api = String(api);
}

// On Windows binaries carry a suffix and the SDK wrappers are .bat files.
export const exe = (n) => (isWin ? `${n}.exe` : n);
export const bat = (n) => (isWin ? `${n}.bat` : n);

export function which(cmd) {
  try {
    const out = execFileSync(isWin ? 'where' : 'which', [cmd], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split(/\r?\n/).find(Boolean) || null;
  } catch { return null; }
}

export function run(cmd, args, opts = {}) {
  try {
    const out = execFileSync(cmd, args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeout ?? 30000, ...opts,
    });
    // With encoding:'buffer' (screenshots) the output is binary and must not be
    // touched; only text gets trimmed.
    return { ok: true, out: typeof out === 'string' ? out.trim() : out };
  } catch (e) {
    // Keep the command's own output separate from the spawn failure. A shell
    // command that exits non-zero with no output should print nothing, the way a
    // real shell behaves -- not "Command failed: /long/path/to/adb ...".
    const err = (e.stdout?.toString() || '') + (e.stderr?.toString() || '');
    return { ok: false, out: err.trim(), error: e.message, code: e.status ?? 1 };
  }
}

// A real JDK, not the macOS stub at /usr/bin/java that only prints "Unable to
// locate a Java Runtime". avdmanager and sdkmanager need an actual runtime, so
// every candidate is verified by running it.
export function findJavaHome() {
  const seen = [];
  const add = (p) => { if (p && !seen.includes(p)) seen.push(p); };

  add(process.env.JAVA_HOME);
  if (isMac) {
    for (const args of [['-v', '17'], []]) {
      const r = run('/usr/libexec/java_home', args);
      if (r.ok) add(r.out);
    }
  }
  for (const base of ['/opt/homebrew/opt', '/usr/local/opt']) {
    for (const v of ['openjdk@17', 'openjdk@21', 'openjdk']) add(`${base}/${v}`);
  }
  if (isLinux) {
    try {
      for (const d of readdirSync('/usr/lib/jvm')) add(`/usr/lib/jvm/${d}`);
    } catch { /* no jvm directory */ }
  }

  for (const home of seen) {
    if (existsSync(path.join(home, 'bin', exe('java')))
        && run(path.join(home, 'bin', exe('java')), ['-version']).ok) {
      return home;
    }
  }
  // A java already on PATH counts, as long as it actually runs.
  const onPath = which(exe('java'));
  if (onPath && run(onPath, ['-version']).ok) return path.dirname(path.dirname(onPath));
  return null;
}

// --- host capabilities ------------------------------------------------------

export function hasDocker() {
  if (!which(exe('docker'))) return { ok: false, why: 'docker is not installed' };
  const r = run(exe('docker'), ['info', '--format', '{{.OperatingSystem}}']);
  if (!r.ok) return { ok: false, why: 'the docker daemon is not responding' };
  return { ok: true, engine: r.out };
}

// redroid needs binder in the HOST kernel. Docker Desktop (macOS/Windows) runs a
// LinuxKit kernel built without CONFIG_ANDROID_BINDER_IPC, and that cannot be
// added without replacing the VM's kernel.
export function hasBinder() {
  if (!isLinux) {
    return { ok: false, why: `the Docker Desktop kernel on ${osName} has no binder (CONFIG_ANDROID_BINDER_IPC)` };
  }
  if (existsSync('/dev/binder') || existsSync('/dev/binderfs/binder')) return { ok: true, how: '/dev/binder' };
  const r = run('modprobe', ['binder_linux', 'devices=binder,hwbinder,vndbinder']);
  if (r.ok && (existsSync('/dev/binder') || existsSync('/dev/binderfs'))) {
    return { ok: true, how: 'binder_linux module loaded' };
  }
  try {
    const cfgFile = `/boot/config-${execSync('uname -r', { encoding: 'utf8' }).trim()}`;
    if (existsSync(cfgFile) && /CONFIG_ANDROID_BINDERFS=[ym]/.test(readFileSync(cfgFile, 'utf8'))) {
      return { ok: false, why: 'kernel supports binderfs but it is not mounted: try `sudo modprobe binder_linux devices=binder,hwbinder,vndbinder`' };
    }
  } catch { /* kernel config is not always readable */ }
  return { ok: false, why: 'the kernel does not expose binder' };
}

export function hasAccel() {
  if (isMac) return { ok: true, how: 'Hypervisor.framework' }; // present on every modern macOS
  if (isLinux) {
    return existsSync('/dev/kvm')
      ? { ok: true, how: '/dev/kvm' }
      : { ok: false, why: 'no /dev/kvm (enable virtualisation in the BIOS and join the kvm group)' };
  }
  if (isWin) {
    const r = run('powershell', ['-NoProfile', '-Command',
      '(Get-ComputerInfo -Property HyperVRequirementVirtualizationFirmwareEnabled).HyperVRequirementVirtualizationFirmwareEnabled']);
    if (r.ok && /true/i.test(r.out)) return { ok: true, how: 'WHPX (Hyper-V)' };
    return { ok: false, why: 'could not confirm WHPX; enable "Virtual Machine Platform" in Windows Features' };
  }
  return { ok: false, why: `unsupported platform: ${OS}` };
}

// Only picks a backend when one was not forced. redroid boots faster and weighs
// less, but it only exists where binder is real: Linux.
export function pickBackend(forced) {
  if (forced) return forced;
  if (process.env.ANDROID_LAB_BACKEND) return process.env.ANDROID_LAB_BACKEND;
  if (isLinux && hasDocker().ok && hasBinder().ok) return 'redroid';
  return 'emulator';
}
