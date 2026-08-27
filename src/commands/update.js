// Updates the moving parts: the SDK packages or the container image, plus a
// check of whether a newer CLI is on npm. It never updates itself in place --
// that is the package manager's job, and doing it behind your back would be rude.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { c, ok, say, step, warn } from '../log.js';
import { bat, cfg, exe, paths, run } from '../platform.js';

const pkg = () => JSON.parse(readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8'));

export default async function update(be, args) {
  const local = pkg().version;

  step('checking npm for a newer android-lab');
  const r = run(exe('npm'), ['view', 'android-lab', 'version'], { timeout: 30000 });
  if (!r.ok) {
    warn(`could not reach npm (${r.out?.split('\n')[0] || 'no answer'}). Skipping the version check.`);
  } else if (r.out && r.out !== local) {
    say(`  ${c.yellow('update available')}  ${c.dim(local)} -> ${c.green(r.out)}`);
    say(`  ${c.dim('npm i -g android-lab@latest')}`);
  } else {
    ok(`android-lab ${local} is the latest`);
  }

  if (args.checkOnly) return;

  if (be.name === 'redroid') {
    step(`pulling ${cfg.redroidImage}`);
    const p = run(exe('docker'), ['pull', cfg.redroidImage],
      { timeout: 1800000, stdio: ['ignore', 'inherit', 'inherit'] });
    if (!p.ok) throw new Error(`could not pull the image: ${p.out?.slice(-300)}`);
    return ok('image updated. Recreate the device to pick it up: android-lab clean --remove && android-lab start');
  }

  const sdkmanager = path.join(paths().sdk, 'cmdline-tools', 'latest', 'bin', bat('sdkmanager'));
  step('updating installed SDK packages');
  const u = run(sdkmanager, [`--sdk_root=${paths().sdk}`, '--update'],
    { timeout: 1800000, stdio: ['ignore', 'inherit', 'inherit'] });
  if (!u.ok) throw new Error(`sdkmanager --update failed: ${u.out?.slice(-300)}`);
  ok('SDK packages updated. Existing devices keep their data.');
}
