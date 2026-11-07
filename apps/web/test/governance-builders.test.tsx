import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { PolicyBuilder, ScorecardBuilder } from '../src/components/builder/GovernanceBuilders';
import { api } from '../src/lib/api';
import { renderUi } from './render';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.spyOn(api, 'blueprints').mockResolvedValue([{ identifier: 'service', title: 'Service' } as never]);
  vi.spyOn(api, 'actions').mockResolvedValue([]);
  vi.spyOn(api, 'checkExpression').mockResolvedValue({ ok: true, value: true } as never);
});

const policy = {
  identifier: 'needs-ticket',
  title: 'Needs ticket',
  description: '',
  enabled: true,
  target: 'run',
  match: {},
  expression: 'inputs.ticket != null',
  message: 'No ticket',
};
const scorecard = {
  identifier: 'ready',
  title: 'Ready',
  description: '',
  blueprint: 'service',
  levels: [{ name: 'Bronze', color: 'orange' }],
  rules: [{ identifier: 'owner', title: 'Has owner', level: 'Bronze', expression: 'team != null' }],
};
const open = (el: React.ReactNode) => renderUi(el);

describe('PolicyBuilder', () => {
  it('edits the document, mirrors it in YAML and saves', async () => {
    const save = vi.fn().mockResolvedValue({});
    open(<PolicyBuilder isNew={false} value={policy} onSave={save} onClose={() => undefined} />);
    fireEvent.change(await screen.findByLabelText(/^Title/), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('tab', { name: 'YAML' }));
    const yaml = (await screen.findByLabelText('YAML document')) as HTMLTextAreaElement;
    expect(yaml.value).toContain('title: Renamed');
    expect(yaml.value).toContain('target: run');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('needs-ticket', expect.objectContaining({ title: 'Renamed', match: {}, expression: 'inputs.ticket != null' })),
    );
  });

  it('blocks saving without an expression', async () => {
    const save = vi.fn();
    open(<PolicyBuilder isNew={false} value={{ ...policy, expression: '' }} onSave={save} onClose={() => undefined} />);
    await screen.findByLabelText(/^Title/);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Expression is required/);
    expect(save).not.toHaveBeenCalled();
  });

  it('is read-only when managed', async () => {
    open(<PolicyBuilder isNew={false} readOnly value={policy} onSave={vi.fn()} onClose={() => undefined} />);
    expect((await screen.findByLabelText(/^Title/)).closest('fieldset')?.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});

describe('ScorecardBuilder', () => {
  it('adds a level and a rule, shown in the JSON view', async () => {
    open(<ScorecardBuilder isNew={false} value={scorecard} onSave={vi.fn()} onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('tab', { name: /Levels/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add level/ }));
    fireEvent.change(screen.getByLabelText('Level 2 name'), { target: { value: 'Silver' } });
    fireEvent.click(screen.getByRole('tab', { name: 'JSON' }));
    const json = (await screen.findByLabelText('JSON document')) as HTMLTextAreaElement;
    expect(json.value).toContain('Silver');
  });

  it('blocks a rule on an undefined level and duplicated identifiers', async () => {
    const save = vi.fn();
    const bad = { ...scorecard, rules: [scorecard.rules[0], { ...scorecard.rules[0], level: 'Gold' }] };
    open(<ScorecardBuilder isNew={false} value={bad} onSave={save} onClose={() => undefined} />);
    await screen.findByLabelText(/^Title/);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/level "Gold" is not defined/);
    expect(screen.getByText(/identifiers must be unique/)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it('saves a valid scorecard and is read-only when managed', async () => {
    const save = vi.fn().mockResolvedValue({});
    const { unmount } = open(<ScorecardBuilder isNew={false} value={scorecard} onSave={save} onClose={() => undefined} />);
    await screen.findByLabelText(/^Title/);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('ready', expect.objectContaining({ blueprint: 'service', levels: scorecard.levels, rules: scorecard.rules })),
    );
    unmount();
    cleanup();
    open(<ScorecardBuilder isNew={false} readOnly value={scorecard} onSave={vi.fn()} onClose={() => undefined} />);
    expect((await screen.findByLabelText(/^Title/)).closest('fieldset')?.disabled).toBe(true);
  });
});
