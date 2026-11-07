import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PropertyValue } from '../src/components/PropertyValue';
import { renderUi } from './render';

afterEach(cleanup);

// Source text of every module (Vite raw imports: the web package has no Node types).
const RAW = import.meta.glob<string>(['../src/**/*.{ts,tsx}', '!../src/components/CodeEditor.tsx'], { query: '?raw', import: 'default', eager: true });

/** Every JSON / YAML document goes through CodeEditor (edit) or CodeBlock / JsonBlock / InlineCode (view). */
describe('JSON / YAML are always highlighted', () => {
  const sources = Object.entries(RAW).map(([f, s]) => ({ f, s }));

  it('reads the sources', () => {
    expect(sources.length).toBeGreaterThan(50);
  });

  it('no Mantine JsonInput', () => {
    expect(sources.filter(({ s }) => /\bJsonInput\b/.test(s)).map(({ f }) => f)).toEqual([]);
  });

  it('no stringified JSON rendered in <Code> or <pre>', () => {
    const raw = /<(Code|pre)\b[^>]*>\s*\{\s*JSON\.stringify/;
    expect(sources.filter(({ s }) => raw.test(s)).map(({ f }) => f)).toEqual([]);
  });

  it('no YAML in a plain textarea', () => {
    expect(sources.filter(({ s }) => /<Textarea[^>]*(aria-label="YAML|value=\{yaml\})/.test(s)).map(({ f }) => f)).toEqual([]);
  });

  it('object properties render as highlighted JSON', () => {
    renderUi(<PropertyValue value={{ replicas: 3 }} />);
    const block = document.querySelector('pre.code-block');
    expect(block?.textContent).toContain('"replicas": 3');
    expect(block?.querySelector('.tok-key')).toBeTruthy();
  });

  it('YAML properties render highlighted', () => {
    renderUi(<PropertyValue schema={{ type: 'string', format: 'yaml' }} value={'image: nginx\nreplicas: 2'} />);
    expect(document.querySelector('pre.code-block .tok-key')?.textContent).toBe('image');
    expect(screen.queryByText('image: nginx')).toBeNull();
  });
});
