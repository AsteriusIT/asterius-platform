import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { DashboardBuilder } from '../src/components/builder/DashboardBuilder';
import { renderUi } from './render';

afterEach(cleanup);

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const template = {
  identifier: 'home',
  title: 'Home',
  description: '',
  default: true,
  widgets: [
    { type: 'count', title: 'Services', blueprint: 'service', width: 3 },
    { type: 'approvals', width: 6 },
  ],
};

function setup(over: Partial<Parameters<typeof DashboardBuilder>[0]> = {}) {
  const onSave = vi.fn(async () => undefined);
  renderUi(<DashboardBuilder isNew={false} value={template} onSave={onSave} onClose={() => undefined} {...over} />);
  return { onSave };
}
const widgets = () => screen.getAllByTestId('widget');

describe('DashboardBuilder', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('/api/v1/blueprints')) return json([{ identifier: 'service', title: 'Service', schema: { properties: {} }, relations: {} }]);
        return json([]);
      }),
    );
  });

  it('renders the template and its widgets', async () => {
    setup();
    expect(((await screen.findByLabelText(/^Title/)) as HTMLInputElement).value).toBe('Home');
    fireEvent.click(screen.getByRole('tab', { name: /Widgets/ }));
    expect(widgets()).toHaveLength(2);
    expect(within(widgets()[0]).getByText('Services')).toBeTruthy();
  });

  it('adds, reorders, duplicates and removes widgets, with per-type fields', async () => {
    setup();
    fireEvent.click(await screen.findByRole('tab', { name: /Widgets/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add widget/ }));
    fireEvent.click(await screen.findByText('Markdown'));
    expect(widgets()).toHaveLength(3);
    expect(screen.getByLabelText(/^Content/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Content/), { target: { value: '# Hello' } });
    expect((await screen.findByTestId('markdown-preview')).textContent).toContain('Hello');

    fireEvent.click(within(widgets()[2]).getByLabelText('Move widget up'));
    expect(within(widgets()[1]).getAllByText('Markdown').length).toBeGreaterThan(0);
    fireEvent.click(within(widgets()[0]).getByLabelText('Duplicate widget'));
    expect(widgets()).toHaveLength(4);
    fireEvent.click(within(widgets()[1]).getByLabelText('Remove widget'));
    expect(widgets()).toHaveLength(3);
  });

  it('reflects edits in the YAML and JSON views', async () => {
    setup();
    fireEvent.change(await screen.findByLabelText(/^Title/), { target: { value: 'Platform' } });
    fireEvent.click(screen.getByRole('tab', { name: 'YAML' }));
    expect(document.body.textContent).toContain('title: Platform');
    fireEvent.click(screen.getByRole('tab', { name: 'JSON' }));
    expect(document.body.textContent).toContain('"title": "Platform"');
  });

  it('blocks saving a dashboard without widgets or with missing fields', async () => {
    const { onSave } = setup({ value: { ...template, widgets: [{ type: 'count', width: 6 }] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Widget 1 \(count\): blueprint is required/)).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
    cleanup();
    const second = setup({ value: { ...template, widgets: [] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Add at least one widget')).toBeTruthy();
    expect(second.onSave).not.toHaveBeenCalled();
  });

  it('saves the document', async () => {
    const { onSave } = setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith('home', {
      identifier: 'home',
      title: 'Home',
      description: '',
      default: true,
      team: null,
      blueprint: null,
      widgets: template.widgets,
    });
  });

  it('opens managed dashboards read-only', async () => {
    setup({ readOnly: true });
    expect((await screen.findByLabelText(/^Title/)).closest('fieldset')?.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});
