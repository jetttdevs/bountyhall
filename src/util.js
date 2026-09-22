// Small shared helpers: ids, hashing, a test-adjustable clock, input validation.
import { createHash, randomBytes } from 'node:crypto';

let clockOffset = 0;
export const now = () => Date.now() + clockOffset;
export const advanceClock = (ms) => { clockOffset += ms; };
export const resetClock = () => { clockOffset = 0; };

export const HOUR = 3600_000;
export const MINUTE = 60_000;

export const newId = (prefix) => `${prefix}_${randomBytes(8).toString('hex')}`;
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

export class HttpError extends Error {
  constructor(status, message, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function str(value, name, { min = 1, max = 2000, required = true } = {}) {
  if (value == null || value === '') {
    if (!required) return '';
    throw new HttpError(400, `${name} is required`, 'invalid_input');
  }
  if (typeof value !== 'string') throw new HttpError(400, `${name} must be a string`, 'invalid_input');
  const v = value.trim();
  if (v.length < min) throw new HttpError(400, `${name} must be at least ${min} characters`, 'invalid_input');
  if (v.length > max) throw new HttpError(400, `${name} must be at most ${max} characters`, 'invalid_input');
  return v;
}

export function int(value, name, { min, max, fallback } = {}) {
  if (value == null || value === '') {
    if (fallback !== undefined) return fallback;
    throw new HttpError(400, `${name} is required`, 'invalid_input');
  }
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isInteger(n)) throw new HttpError(400, `${name} must be an integer`, 'invalid_input');
  if (min != null && n < min) throw new HttpError(400, `${name} must be >= ${min}`, 'invalid_input');
  if (max != null && n > max) throw new HttpError(400, `${name} must be <= ${max}`, 'invalid_input');
  return n;
}

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
