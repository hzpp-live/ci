import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';

const envFile = process.env.CI_ENV_FILE?.trim() || '.env';

if (existsSync(envFile)) {
	loadEnvFile(envFile);
}

await import('../server/index.ts');
