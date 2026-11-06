import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { AiDraft, parseSample } from '../src/components/AiAssistant';
import { api } from '../src/lib/api';
import { renderUi } from './render';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const status = (enabled: boolean) => vi.spyOn(api, 'aiStatus').mockResolvedValue({ enabled, provider: 'anthropic', assistantModel: 'm' });

describe('AiDraft', () => {
  it('renders nothing when no model is configured', async () => {
    const spy = status(false);
    renderUi(<AiDraft label="Draft" title="T" help="h" placeholder="p" run={async () => 1} onDraft={() => undefined} />);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(screen.queryByText('Draft')).toBeNull();
  });

  it('drafts, previews and applies only when the user accepts', async () => {
    status(true);
    const onDraft = vi.fn();
    const run = vi.fn(async (t: string) => ({ echo: t }));
    renderUi(<AiDraft label="Draft with AI" title="T" help="h" placeholder="p" run={run} preview={(d) => <div>draft:{d.echo}</div>} onDraft={onDraft} />);
    fireEvent.click(await screen.findByText('Draft with AI'));
    fireEvent.change(screen.getByPlaceholderText('p'), { target: { value: 'a database' } });
    fireEvent.click(screen.getByRole('button', { name: 'Draft' }));
    expect(await screen.findByText('draft:a database')).toBeTruthy();
    expect(onDraft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Use this draft' }));
    expect(onDraft).toHaveBeenCalledWith({ echo: 'a database' });
  });
});

describe('parseSample', () => {
  it('treats JSON as a sample and anything else as a description', () => {
    expect(parseSample('{"a":1}')).toEqual({ sample: { a: 1 } });
    expect(parseSample('a database with an engine')).toEqual({ description: 'a database with an engine' });
    expect(parseSample('{broken')).toEqual({ description: '{broken' });
  });
});
