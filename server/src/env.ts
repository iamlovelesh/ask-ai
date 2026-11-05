import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const envPath = resolve(__dirname, '../../.env');

/**
 * Load environment variables from a .env file.
 * - Reads repo-root .env relative to this module
 * - Parses simple KEY=VALUE lines (no multiline, no expansion)
 * - Ignores comments (lines starting with #) and blank lines
 * - Strips optional surrounding quotes (single or double) from values
 * - Only sets process.env if the key is not already set (respects pre-set env)
 */
export function loadEnv(): void {
  try {
    const content = readFileSync(envPath, 'utf8');
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) {
        continue;
      }

      const key = trimmed.substring(0, eqIdx).trim();
      let value = trimmed.substring(eqIdx + 1).trim();

      // Strip surrounding quotes (single or double)
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      // Only set if not already in process.env (preserve pre-set env vars)
      if (!process.env.hasOwnProperty(key)) {
        process.env[key] = value;
      }
    }
  } catch {
    // Gracefully handle missing .env file
  }
}

// Load immediately on import
loadEnv();
