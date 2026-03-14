import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '../..');

describe('frontend smoke checks', () => {
  it('includes required map capabilities in the Next.js client component', () => {
    const page = fs.readFileSync(path.join(root, 'app', 'page.jsx'), 'utf8');
    const layout = fs.readFileSync(path.join(root, 'app', 'layout.jsx'), 'utf8');
    const script = fs.readFileSync(path.join(root, 'components', 'crime-map.jsx'), 'utf8');
    const firebaseConfig = fs.readFileSync(path.join(root, 'firebase.json'), 'utf8');

    expect(page).toContain('<CrimeMap />');
    expect(layout).toContain('src="/runtime-config.js"');
    expect(script).toContain("'use client'");
    expect(script).toContain('id="map"');
    expect(script).toContain('className="time-widget"');
    expect(script).toContain('id="time-slider"');
    expect(script).not.toContain('id="category-toggles"');
    expect(script).not.toContain('id="incident-drawer"');
    expect(script).toContain('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png');
    expect(script).toContain('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png');
    expect(script).toContain('setMaxBounds');
    expect(script).toContain('/api/incidents');
    expect(script).toContain('/fallback-incidents.json');
    expect(script).toContain('/fallback-meta.json');
    expect(script).toContain('TIME_PRESETS');
    expect(script).not.toContain('buildIncidentDetailUrl');
    expect(firebaseConfig).toContain('"public": "out"');
    expect(firebaseConfig).toContain('"destination": "/index.html"');
  });
});
