// Which devices exist, what port each one got. Kept on disk because the port is
// allocated at start time and every later command (stop, shell, screen) needs to
// find the same device again.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { paths } from './platform.js';

const load = () => {
  try { return JSON.parse(readFileSync(paths().state, 'utf8')); }
  catch { return { instances: {} }; }
};

const save = (s) => {
  mkdirSync(paths().home, { recursive: true });
  writeFileSync(paths().state, JSON.stringify(s, null, 2) + '\n');
};

export const getInstance = (name) => load().instances?.[name] ?? null;

export function setInstance(name, data) {
  const s = load();
  s.instances ??= {};
  s.instances[name] = { ...s.instances[name], ...data };
  save(s);
  return s.instances[name];
}

export function removeInstance(name) {
  const s = load();
  if (s.instances) delete s.instances[name];
  save(s);
}

export const listInstances = () =>
  Object.entries(load().instances ?? {}).map(([name, v]) => ({ name, ...v }));
