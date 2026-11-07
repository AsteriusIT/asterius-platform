import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { ResourceAdmin } from '../src/pages/admin/ResourceAdmin';
import { renderUi } from './render';

afterEach(cleanup);

const base = {
  title: 'Things',
  description: 'd',
  queryKey: 'things',
  list: async () => [],
  columns: [],
  toEditable: (x: Record<string, unknown>) => x,
  save: async () => ({}),
  remove: async () => ({}),
};
const editor = (p: { value: Record<string, unknown> | null }) => (p.value ? <div>editing {String(p.value.type)}</div> : null);

describe('template picker', () => {
  it('opens a modal of cards, filters by search and opens the editor with the chosen template', async () => {
    renderUi(
      <ResourceAdmin
        {...base}
        editor={editor}
        templates={[
          { label: 'GitHub', icon: 'github', description: 'Repos', group: 'Source control', value: { type: 'github' } },
          { label: 'PagerDuty', icon: 'pagerduty', description: 'Incidents', group: 'Incidents', value: { type: 'pagerduty' } },
        ]}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'New' }));
    expect(await screen.findByRole('button', { name: 'GitHub' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'PagerDuty' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'incid' } });
    expect(screen.queryByRole('button', { name: 'GitHub' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'PagerDuty' }));
    expect(await screen.findByText('editing pagerduty')).toBeTruthy();
  });

  it('opens the editor directly with a single template', async () => {
    renderUi(<ResourceAdmin {...base} editor={editor} templates={[{ label: 'Only', value: { type: 'only' } }]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'New' }));
    expect(await screen.findByText('editing only')).toBeTruthy();
  });
});
