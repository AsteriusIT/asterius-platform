import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { Meta } from '@asterius/shared';
import { FormEditor } from '../src/components/builder/FormEditor';
import { IntegrationForm } from '../src/components/builder/IntegrationForm';
import { WebhookForm } from '../src/components/builder/WebhookForm';
import { api } from '../src/lib/api';
import { renderUi } from './render';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const meta = {
  sources: [
    {
      type: 'http',
      title: 'HTTP API',
      description: 'Poll a JSON API',
      example: { config: { url: 'https://x' } },
      kinds: ['item'],
      fields: [{ key: 'url', label: 'URL', kind: 'text', required: true }],
    },
  ],
  invokers: [],
  models: [],
} as unknown as Meta;

function Webhook({ onSave }: { onSave: (id: string, body: Record<string, unknown>) => Promise<unknown> }) {
  return (
    <FormEditor
      title="Webhook"
      isNew={false}
      value={{ identifier: 'hook', title: 'Hook', url: 'https://example.internal/hook', events: ['run.*'], blueprints: [], enabled: true }}
      form={(doc, patch) => <WebhookForm doc={doc} patch={patch} isNew={false} />}
      onSave={onSave}
      onClose={() => undefined}
    />
  );
}

describe('webhook form', () => {
  it('edits fields, sends a test delivery and saves the document', async () => {
    vi.spyOn(api, 'blueprints').mockResolvedValue([]);
    vi.spyOn(api, 'secrets').mockResolvedValue([]);
    const test = vi.spyOn(api, 'testWebhook').mockResolvedValue({ queued: true });
    const save = vi.fn().mockResolvedValue({});
    renderUi(<Webhook onSave={save} />);
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: /Send test delivery/ }));
    await waitFor(() => expect(test).toHaveBeenCalledWith('hook'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith('hook', expect.objectContaining({ title: 'Renamed', url: 'https://example.internal/hook' })));
  });

  it('keeps the form and YAML tabs in sync', async () => {
    vi.spyOn(api, 'blueprints').mockResolvedValue([]);
    vi.spyOn(api, 'secrets').mockResolvedValue([]);
    const save = vi.fn().mockResolvedValue({});
    renderUi(<Webhook onSave={save} />);
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'FromForm' } });
    fireEvent.click(screen.getByRole('tab', { name: 'YAML' }));
    const yaml = (await screen.findByLabelText('YAML document')) as HTMLTextAreaElement;
    expect(yaml.value).toContain('title: FromForm');
    fireEvent.change(yaml, { target: { value: yaml.value.replace('FromForm', 'FromYaml') } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith('hook', expect.objectContaining({ title: 'FromYaml' })));
  });
});

describe('integration form', () => {
  it('tests the connection and previews a mapping on a sample item', async () => {
    vi.spyOn(api, 'meta').mockResolvedValue(meta);
    vi.spyOn(api, 'blueprints').mockResolvedValue([{ identifier: 'app', title: 'App' } as never]);
    const test = vi.spyOn(api, 'testIntegration').mockResolvedValue({ ok: true, sample: [{ code: 'a1', name: 'Alpha' }] });
    const preview = vi
      .spyOn(api, 'previewMapping')
      .mockResolvedValue({ mapped: [{ blueprint: 'app', identifier: 'a1', title: 'Alpha' }] as never, skipped: 0 });
    const doc = {
      identifier: 'cmdb',
      title: 'CMDB',
      type: 'http',
      config: { url: 'https://x' },
      mappings: [{ kind: 'item', entity: { blueprint: 'app', identifier: 'code', properties: {} } }],
    };
    renderUi(<IntegrationForm doc={doc} patch={() => undefined} isNew={false} />);
    fireEvent.click(await screen.findByRole('button', { name: /Test connection/ }));
    await waitFor(() => expect(test).toHaveBeenCalledWith(expect.objectContaining({ type: 'http' })));
    await screen.findByText(/Connected/);
    await waitFor(() => expect(preview).toHaveBeenCalled());
    expect((await screen.findByLabelText('Mapping preview')).textContent).toContain('Alpha');
  });
});
