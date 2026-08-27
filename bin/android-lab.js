#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2)).catch((err) => {
  console.error(`\x1b[31merror\x1b[0m  ${err?.message || err}`);
  if (process.env.ANDROID_LAB_DEBUG) console.error(err?.stack);
  process.exit(1);
});
