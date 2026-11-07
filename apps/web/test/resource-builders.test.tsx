import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { PluginInfo } from '@asterius/shared';
import { TeamBuilder } from '../src/components/builder/SimpleBuilders';
import { EntityIcon, ICON_NAMES, iconTitle, isImageIcon } from '../src/components/icons';
import { readIconFile } from '../src/components/IconPicker';
import { renderUi } from './render';

afterEach(cleanup);

const github: PluginInfo = {
  type: 'github',
  title: 'GitHub',
  description: 'Repositories',
  kinds: ['repository'],
  example: { type: 'github', config: { org: 'my-org', token: '${secret:GITHUB_TOKEN}' } },
  fields: [
    { key: 'org', label: 'Organization', kind: 'text', required: true },
    { key: 'token', label: 'Token', kind: 'secret', required: true },
  ],
};

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

describe('form builders', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/meta') return json({ name: 'Asterius Platform', logo: null, authProviders: ['local'], invokers: [], sources: [github] });
        if (url.startsWith('/api/v1/blueprints')) return json([{ identifier: 'repository', title: 'Repository', schema: { properties: {} }, relations: {} }]);
        return json([]);
      }),
    );
  });

  it('opens managed teams read-only', async () => {
    renderUi(<TeamBuilder isNew={false} readOnly value={{ identifier: 'ops', title: 'Ops', description: '' }} onSave={vi.fn()} onClose={() => undefined} />);
    expect((await screen.findByLabelText(/^Title/)).closest('fieldset')?.disabled).toBe(true);
    expect(screen.queryByText('Save')).toBeNull();
  });
});

describe('icons', () => {
  it('renders custom images and built-in names', () => {
    expect(isImageIcon('https://x.example/a.png')).toBe(true);
    expect(isImageIcon('data:image/png;base64,AAAA')).toBe(true);
    expect(isImageIcon('rocket')).toBe(false);
    const { container } = render(<EntityIcon name="https://x.example/a.png" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://x.example/a.png');
  });

  it('shows official service logos, also for the earlier brand-* names', () => {
    const logo = (name: string) => render(<EntityIcon name={name} />).container.firstElementChild as HTMLElement;
    expect(logo('azure-devops').tagName).toBe('IMG');
    expect(logo('azure-devops').getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    expect(logo('brand-kubernetes').getAttribute('src')).toBe(logo('kubernetes').getAttribute('src'));
    expect(logo('github').tagName).toBe('SPAN'); // black logo: painted with the text color
    expect(iconTitle('brand-azure')).toBe('Microsoft Azure');
    for (const n of ['kubernetes', 'helm', 'argo-cd', 'terraform', 'prometheus', 'postgresql']) expect(ICON_NAMES).toContain(n);
  });

  it('rejects uploads that are not small images', async () => {
    await expect(readIconFile(new File(['x'], 'a.txt', { type: 'text/plain' }))).rejects.toThrow(/PNG, JPEG/);
    await expect(readIconFile(new File([new Uint8Array(60_000)], 'big.png', { type: 'image/png' }))).rejects.toThrow(/too large/);
    expect(await readIconFile(new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' }))).toMatch(/^data:image\/svg\+xml;base64,/);
  });
});
