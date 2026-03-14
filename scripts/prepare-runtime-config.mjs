import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');

const defaultArg = process.argv.find((arg) => arg.startsWith('--default-api-base-url='));
const defaultApiBaseUrl = defaultArg ? defaultArg.slice('--default-api-base-url='.length) : '';
const apiBaseUrl = (process.env.FRONTEND_API_BASE_URL || defaultApiBaseUrl || '').trim();

await fs.mkdir(publicDir, { recursive: true });
await fs.writeFile(
  path.join(publicDir, 'runtime-config.js'),
  `window.CCM_CONFIG = Object.assign({}, window.CCM_CONFIG, { apiBaseUrl: ${JSON.stringify(apiBaseUrl)} });\n`,
  'utf8'
);
