import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Loads the repo-root .env for local CLI scripts (migrate, seed).
 * In staging and production the variables come from Coolify, and no .env exists.
 */
export function loadDotEnv(): void {
  const envPath = resolve(import.meta.dirname, '../../../../.env');
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}
