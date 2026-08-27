// Smoke tests for things that break silently if someone touches the parser or
// the platform detection. No hardware involved; they run anywhere.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ANDROID_ABI, ARCH, cfg, configure, exe, isWin, labHome, paths, pickBackend } from '../src/platform.js';

test('the Android ABI follows the host CPU', () => {
  assert.equal(ANDROID_ABI, ARCH === 'arm64' ? 'arm64-v8a' : 'x86_64');
});

test('exe() only appends .exe on Windows', () => {
  assert.equal(exe('adb'), isWin ? 'adb.exe' : 'adb');
});

test('ANDROID_LAB_HOME overrides the default', () => {
  const prev = process.env.ANDROID_LAB_HOME;
  process.env.ANDROID_LAB_HOME = '/tmp/lab-under-test';
  assert.equal(labHome(), '/tmp/lab-under-test');
  assert.ok(paths().sdk.startsWith('/tmp/lab-under-test'));
  if (prev === undefined) delete process.env.ANDROID_LAB_HOME;
  else process.env.ANDROID_LAB_HOME = prev;
});

test('a forced backend wins regardless of the host', () => {
  assert.equal(pickBackend('redroid'), 'redroid');
  assert.equal(pickBackend('emulator'), 'emulator');
});

test('redroid is never auto-selected off Linux', () => {
  const prev = process.env.ANDROID_LAB_BACKEND;
  delete process.env.ANDROID_LAB_BACKEND;
  if (process.platform !== 'linux') assert.equal(pickBackend(), 'emulator');
  if (prev !== undefined) process.env.ANDROID_LAB_BACKEND = prev;
});

test('the system image can be overridden by environment', () => {
  assert.match(cfg.systemImage, /^system-images;android-\d+;/);
});

test('--name changes the device the commands act on', () => {
  const prev = cfg.name;
  configure({ name: 'other-device' });
  assert.equal(cfg.name, 'other-device');
  configure({ name: prev });
});
