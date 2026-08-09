const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', grey: '\x1b[90m',
};

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c, s) => (useColor ? c + s + C.reset : s);

const stamp = () => new Date().toTimeString().slice(0, 8);

export const log = {
  info:  (...a) => console.log(paint(C.grey, stamp()), ...a),
  ok:    (...a) => console.log(paint(C.grey, stamp()), paint(C.green, '✓'), ...a),
  warn:  (...a) => console.log(paint(C.grey, stamp()), paint(C.yellow, '!'), ...a),
  error: (...a) => console.error(paint(C.grey, stamp()), paint(C.red, '✗'), ...a),
  step:  (...a) => console.log('\n' + paint(C.bold + C.cyan, '▸'), paint(C.bold, a.join(' '))),
  plain: (...a) => console.log(...a),
};

export const c = {
  dim: (s) => paint(C.dim, s),
  bold: (s) => paint(C.bold, s),
  green: (s) => paint(C.green, s),
  yellow: (s) => paint(C.yellow, s),
  red: (s) => paint(C.red, s),
  cyan: (s) => paint(C.cyan, s),
  magenta: (s) => paint(C.magenta, s),
  grey: (s) => paint(C.grey, s),
};

/** Colour a 0-100 score. */
export const scoreColor = (n) =>
  n >= 80 ? c.green(String(n)) : n >= 60 ? c.cyan(String(n)) : n >= 40 ? c.yellow(String(n)) : c.red(String(n));
