/**
 * Shared .env file parser.
 *
 * Reads KEY=VALUE pairs from a .env file and returns them as a plain object.
 * Optionally merges into process.env.
 *
 * @param {object} [opts]
 * @param {string} [opts.path]     — path to .env file (default: <project root>/.env)
 * @param {boolean} [opts.required] — if true, throws when .env is missing (default: false)
 * @param {boolean} [opts.setProcessEnv] — if true, merges into process.env (default: false)
 * @returns {Record<string, string>}
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

export default function loadEnv(opts = {}) {
  const {
    path: envPath = join(ROOT, '.env'),
    required = false,
    setProcessEnv = false,
  } = opts;

  let text;
  try {
    text = readFileSync(envPath, 'utf8');
  } catch {
    // No .env file — fall back to process.env (supports op run / 1Password CLI)
    if (required && !process.env.N8N_BASE_URL) {
      throw new Error(`Missing .env file at ${envPath} (and no env vars found via op run)`);
    }
    return { ...process.env };
  }

  const env = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^([A-Z0-9_]+)=(.+)$/);
    if (match) env[match[1]] = match[2].trim();
  }

  if (setProcessEnv) {
    Object.assign(process.env, env);
  }

  return env;
}
