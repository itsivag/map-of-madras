import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '../..');

describe('frontend smoke checks', () => {
  it('includes required map capabilities in HTML and client script', () => {
    const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
    const script = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

    expect(html).toContain('<div id="map"></div>');
    expect(html).toContain('leaflet.markercluster');
    expect(script).toContain('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png');
    expect(script).toContain('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png');
    expect(script).toContain("map.createPane('bloodmap')");
    expect(script).toContain('setMaxBounds');
    expect(script).toContain('/api/incidents');
  });
});
