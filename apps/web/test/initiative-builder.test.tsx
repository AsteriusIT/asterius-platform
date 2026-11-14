import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { InitiativeView, Scorecard } from '@asterius/shared';
import { goalSentence, InitiativeBuilder, initiativeProblems, toInitiativeDoc } from '../src/components/builder/InitiativeBuilder';
import { InitiativesAdmin } from '../src/pages/Initiatives';
import { api } from '../src/lib/api';
import { renderUi } from './render';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const readiness: Scorecard = {
  identifier: 'production-readiness',
  title: 'Production readiness',
  description: '',
  blueprint: 'service',
  levels: [{ name: 'Bronze' }, { name: 'Silver' }, { name: 'Gold' }],
  rules: [
    { identifier: 'owner', title: 'Has an owner', level: 'Bronze', expression: 'team != null' },
    { identifier: 'has_docs', title: 'Has docs', level: 'Silver', expression: 'properties.docs != null' },
    { identifier: 'slo', title: 'Has an SLO', level: 'Gold', expression: 'properties.slo != null' },
  ],
  managed: false,
};
const docs: Scorecard = {
  identifier: 'documentation',
  title: 'Documentation',
  description: '',
  blueprint: 'library',
  levels: [{ name: 'Basic' }],
  rules: [{ identifier: 'has_docs', title: 'Has docs', level: 'Basic', expression: 'properties.docs != null' }],
  managed: false,
};

const initiative = {
  identifier: 'silver-by-q3',
  title: 'Every service at Silver',
  description: '',
  scorecard: 'production-readiness',
  targetLevel: 'Gold',
  rules: ['has_docs', 'owner'],
  startDate: '2026-01-01',
  deadline: '2026-06-30',
  teams: [],
  owner: null,
  enabled: true,
  reminderDays: 7,
};

beforeEach(() => {
  vi.spyOn(api, 'scorecards').mockResolvedValue([readiness, docs]);
  vi.spyOn(api, 'teams').mockResolvedValue([{ identifier: 'core', title: 'Core' } as never, { identifier: 'payments', title: 'Payments' } as never]);
  vi.spyOn(api, 'userLookup').mockResolvedValue([{ id: 'u1', name: 'Ada', email: 'ada@example.com' }]);
});

/** Mantine Select / MultiSelect / Autocomplete input by its label. */
const field = (label: string) => {
  const name = new RegExp(`^${label}`);
  return screen.queryByRole('combobox', { name }) ?? screen.getByRole('textbox', { name });
};
const pick = async (label: string, option: string | RegExp) => {
  fireEvent.click(field(label));
  fireEvent.click(await screen.findByRole('option', { name: option }));
};

describe('initiative helpers', () => {
  it('describes what done means and mirrors the schema', () => {
    const d = toInitiativeDoc({ ...initiative, targetLevel: 'Silver', rules: ['slo'], teams: ['core', 'payments'] });
    expect(goalSentence(d, readiness)).toBe('Entities of service owned by core and payments must reach Silver and pass Has an SLO by 2026-06-30.');
    expect(initiativeProblems(d, readiness)).toEqual([]);
    const bad = toInitiativeDoc({ ...initiative, targetLevel: 'Platinum', rules: ['nope'], startDate: '2026-02-30', reminderDays: 91 });
    expect(initiativeProblems(bad, readiness)).toEqual([
      'Level "Platinum" is not defined by Production readiness',
      'Rule "nope" is not defined by Production readiness',
      'Start date: a valid date (YYYY-MM-DD) is required',
      'Reminders: a whole number of days between 0 and 90',
    ]);
  });
});

describe('InitiativeBuilder', () => {
  it('creates an initiative from the admin page and saves the body', async () => {
    vi.spyOn(api, 'initiatives').mockResolvedValue([]);
    const save = vi.spyOn(api, 'saveInitiative').mockResolvedValue({} as never);
    renderUi(<InitiativesAdmin />);
    fireEvent.click(await screen.findByRole('button', { name: 'New' }));
    const dialog = await screen.findByRole('dialog', { name: 'New initiative' });
    fireEvent.change(within(dialog).getByLabelText(/^Title/), { target: { value: 'Docs everywhere' } });
    fireEvent.change(within(dialog).getByLabelText(/^Identifier/), { target: { value: 'docs-everywhere' } });

    fireEvent.click(within(dialog).getByRole('tab', { name: /Goal/ }));
    await pick('Scorecard', 'Production readiness (service)');
    await pick('Rules', /Has an SLO/);
    expect(await screen.findByText(/^Entities of service must reach Silver and pass Has an SLO by \d{4}-\d{2}-\d{2}\.$/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('tab', { name: /Schedule and scope/ }));
    fireEvent.change(screen.getByLabelText(/^Start date/), { target: { value: '2026-03-01' } });
    fireEvent.change(screen.getByLabelText(/^Deadline/), { target: { value: '2026-09-30' } });
    await pick('Teams', 'Core');
    fireEvent.change(field('Owner'), { target: { value: 'Ada@Example.com' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create initiative' }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        'docs-everywhere',
        expect.objectContaining({
          identifier: 'docs-everywhere',
          title: 'Docs everywhere',
          scorecard: 'production-readiness',
          targetLevel: 'Silver',
          rules: ['slo'],
          startDate: '2026-03-01',
          deadline: '2026-09-30',
          teams: ['core'],
          owner: 'ada@example.com',
          enabled: true,
          reminderDays: 7,
        }),
        undefined,
      ),
    );
  });

  it('fills the level and rule pickers from the chosen scorecard and drops what the new one lacks', async () => {
    renderUi(<InitiativeBuilder isNew={false} value={initiative} onSave={vi.fn()} onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('tab', { name: /Goal/ }));
    await screen.findByText(/must reach Gold and pass Has docs and Has an owner/);
    expect(screen.getByText('Already required by Gold: has_docs, owner.')).toBeTruthy();
    fireEvent.click(field('Target level'));
    expect(await screen.findByRole('option', { name: 'Bronze' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Gold' })).toBeTruthy();
    fireEvent.keyDown(field('Target level'), { key: 'Escape' });

    await pick('Scorecard', 'Documentation (library)');
    await screen.findByText('Entities of library must pass Has docs by 2026-06-30.');
    fireEvent.click(field('Target level'));
    expect(await screen.findByRole('option', { name: 'Basic' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Gold' })).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'JSON' }));
    const json = JSON.parse(((await screen.findByLabelText('JSON document')) as HTMLTextAreaElement).value);
    expect(json).toMatchObject({ scorecard: 'documentation', targetLevel: null, rules: ['has_docs'] });
  });

  it('shows the validation problems and does not save', async () => {
    const save = vi.fn();
    const bad = { ...initiative, targetLevel: null, rules: [], startDate: '2026-07-01', owner: 'not-an-email', reminderDays: 120 };
    renderUi(<InitiativeBuilder isNew={false} value={bad} onSave={save} onClose={() => undefined} />);
    await screen.findByLabelText(/^Title/);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Set a target level, rules, or both/);
    expect(screen.getByText(/The deadline must not be before the start date/)).toBeTruthy();
    expect(screen.getByText(/Owner: a valid email address/)).toBeTruthy();
    expect(screen.getByText(/whole number of days between 0 and 90/)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it('opens managed initiatives read-only', async () => {
    const view = {
      ...initiative,
      managed: true,
      scorecardTitle: 'Production readiness',
      blueprint: 'service',
      status: 'on_track',
      progress: { passing: 0, total: 0, exempted: 0, ratio: 0 },
      expected: 0,
      daysLeft: 10,
    };
    vi.spyOn(api, 'initiatives').mockResolvedValue([view as InitiativeView]);
    renderUi(<InitiativesAdmin />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'View silver-by-q3' });
    expect((within(dialog).getByLabelText(/^Title/) as HTMLInputElement).closest('fieldset')?.disabled).toBe(true);
    expect(within(dialog).queryByRole('button', { name: 'Save' })).toBeNull();
  });
});
