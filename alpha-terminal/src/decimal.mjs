/** Fixed-point decimal helpers for financial arithmetic. Values are scaled by 10^8. */
export const SCALE = 100_000_000n;

export function parseDecimal(value, { allowNegative = false, maxScale = 8 } = {}) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    throw new TypeError('Expected a decimal string or number');
  }
  const raw = String(value).trim();
  const match = raw.match(/^([+-]?)(\d+)(?:\.(\d*))?$/);
  if (!match) throw new TypeError('Invalid decimal value');
  if (match[1] === '-' && !allowNegative) throw new RangeError('Negative values are not allowed');
  const fraction = match[3] ?? '';
  if (fraction.length > maxScale) throw new RangeError(`At most ${maxScale} decimal places are allowed`);
  const whole = BigInt(match[2]);
  const fractional = BigInt((fraction + '0'.repeat(8)).slice(0, 8) || '0');
  const result = whole * SCALE + fractional;
  return match[1] === '-' ? -result : result;
}

export function decimal(value, options) {
  return formatDecimal(parseDecimal(value, options));
}

export function formatDecimal(units, minimumFractionDigits = 0) {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const whole = absolute / SCALE;
  const fraction = (absolute % SCALE).toString().padStart(8, '0');
  let trimmed = fraction.replace(/0+$/, '');
  if (trimmed.length < minimumFractionDigits) trimmed = trimmed.padEnd(minimumFractionDigits, '0');
  return `${negative ? '-' : ''}${whole.toString()}${trimmed ? `.${trimmed}` : ''}`;
}

export function add(a, b) { return a + b; }
export function sub(a, b) { return a - b; }
export function mul(a, b) { return (a * b) / SCALE; }
export function div(a, b) {
  if (b === 0n) throw new RangeError('Division by zero');
  return (a * SCALE) / b;
}
export function abs(a) { return a < 0n ? -a : a; }
export function min(a, b) { return a < b ? a : b; }
export function max(a, b) { return a > b ? a : b; }
export function sum(values) { return values.reduce((acc, value) => acc + value, 0n); }
export function isPositive(a) { return a > 0n; }

export function percentChange(current, base) {
  if (base === 0n) return 0n;
  return div(mul(sub(current, base), parseDecimal('100')), base);
}

export function toSafeNumber(units) {
  return Number(formatDecimal(units));
}
