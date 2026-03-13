import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const sourceDir = path.join(rootDir, 'public');
const outputDir = path.join(rootDir, 'dist-pages');
const apiBaseUrl = (process.env.PAGES_API_BASE_URL || '').trim();

await fs.rm(outputDir, { recursive: true, force: true });
await fs.cp(sourceDir, outputDir, { recursive: true });

await fs.writeFile(
  path.join(outputDir, 'runtime-config.js'),
  `window.CCM_CONFIG = { apiBaseUrl: ${JSON.stringify(apiBaseUrl)} };\n`,
  'utf8'
);

const indexHtml = await fs.readFile(path.join(outputDir, 'index.html'), 'utf8');
await fs.writeFile(path.join(outputDir, '404.html'), indexHtml, 'utf8');
await fs.writeFile(path.join(outputDir, '.nojekyll'), '', 'utf8');
