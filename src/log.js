// Terminal output, no dependencies. Honours NO_COLOR and pipes.
// FORCE_COLOR / NO_COLOR are the usual conventions; without them, colour is
// dropped whenever output is piped so logs and CI stay readable.
const tty = Boolean(process.env.FORCE_COLOR || process.stdout.isTTY) && !process.env.NO_COLOR;
const wrap = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const c = {
  dim: wrap(2),
  bold: wrap(1),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  cyan: wrap(36),
};

export const say = (...a) => console.log(...a);
export const step = (m) => console.log(`${c.cyan('==>')} ${m}`);
export const ok = (m) => console.log(`${c.green('ok')}    ${m}`);
export const warn = (m) => console.log(`${c.yellow('warn')}  ${m}`);
export const fail = (m) => console.log(`${c.red('fail')}  ${m}`);
export const info = (k, v) => console.log(`  ${c.dim(k.padEnd(18))} ${v}`);

// One-line spinner. Stays quiet when there is no TTY, so piped output and CI
// logs don't fill up with control characters.
export function spinner(text) {
  if (!tty) {
    console.log(`${text}...`);
    return { update() {}, stop() {} };
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  let label = text;
  const draw = () => process.stdout.write(`\r\x1b[K${c.cyan(frames[i++ % frames.length])} ${label}`);
  const timer = setInterval(draw, 80);
  draw();
  return {
    update(t) { label = t; },
    stop(final) {
      clearInterval(timer);
      process.stdout.write('\r\x1b[K');
      if (final) console.log(final);
    },
  };
}

// Yes/no prompt for destructive commands. Auto-confirms when not interactive so
// scripts and CI don't hang forever on a question nobody can answer.
export async function confirm(question, { assumeYes = false } = {}) {
  if (assumeYes) return true;
  if (!process.stdin.isTTY) return false;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${c.yellow('?')} ${question} ${c.dim('[y/N]')} `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}
