import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { Action, FormTrigger, Entity, PublicUser } from '@asterius/shared';
import { canRunOn, matchesSubjects } from '../src/lib/permissions';
import { EntityActionsMenu } from '../src/components/EntityActionsMenu';
import { renderUi } from './render';

afterEach(cleanup);

const alice: PublicUser = {
  id: 'u1',
  email: 'Alice@example.com',
  name: 'Alice',
  provider: 'local',
  role: 'member',
  roles: [],
  active: true,
  teams: [{ identifier: 'payments', title: 'Payments' }],
};

const action = ({ trigger, ...patch }: Partial<Omit<Action, 'trigger'>> & { trigger?: Partial<FormTrigger> | null } = {}): Action => ({
  version: 1,
  identifier: 'a',
  title: 'A',
  description: '',
  icon: null,
  trigger:
    trigger === null
      ? null
      : { type: 'form', on: 'day-2', blueprint: 'database', inputs: { properties: {} }, allowed: {}, approval: { required: false }, ...trigger },
  steps: [{ id: 'run', type: 'invoke', invoker: { type: 'catalog' } }],
  enabled: true,
  managed: false,
  ...patch,
});

const entity = (team: string | null): Entity => ({
  blueprint: 'database',
  identifier: 'db',
  title: 'Payments DB',
  team,
  properties: {},
  relations: {},
  source: 'ui',
  version: 1,
  createdAt: '',
  updatedAt: '',
});

describe('matchesSubjects (same rules as the server)', () => {
  it('matches roles, teams, users and the owning team', () => {
    expect(matchesSubjects(alice, {}, null)).toBe(true);
    expect(matchesSubjects(alice, { roles: ['admin'] }, null)).toBe(false);
    expect(matchesSubjects(alice, { teams: ['payments'] }, null)).toBe(true);
    expect(matchesSubjects(alice, { users: ['alice@EXAMPLE.com'] }, null)).toBe(true);
    expect(matchesSubjects(alice, { ownerTeam: true }, 'payments')).toBe(true);
    expect(matchesSubjects(alice, { ownerTeam: true }, 'checkout')).toBe(false);
    expect(canRunOn(action({ enabled: false }), alice, 'payments')).toBe(false);
    expect(canRunOn(action({}), null, 'payments')).toBe(false);
    expect(canRunOn(action({}), alice, 'payments')).toBe(true);
    expect(canRunOn(action({ trigger: null }), alice, 'payments')).toBe(false); // no trigger: a draft
    expect(canRunOn(action({ steps: [] }), alice, 'payments')).toBe(false); // no step: a draft
  });
});

describe('EntityActionsMenu', () => {
  it('lists day-2 then delete actions, disables what the user may not run, and runs the chosen one', async () => {
    const onRun = vi.fn();
    const actions = [
      action({ identifier: 'grow', title: 'Increase storage', trigger: { allowed: { ownerTeam: true } } }),
      action({ identifier: 'admin-only', title: 'Failover', trigger: { allowed: { roles: ['admin'] } } }),
      action({ identifier: 'drop', title: 'Delete database', trigger: { on: 'delete', approval: { required: true } } }),
    ];
    renderUi(<EntityActionsMenu entity={entity('payments')} actions={actions} user={alice} onRun={onRun} />);
    fireEvent.click(screen.getByLabelText('Actions on Payments DB'));
    await waitFor(() => expect(screen.getByRole('menuitem', { name: /Increase storage/ }).hasAttribute('disabled')).toBe(false));
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent);
    // An action I cannot run says who can.
    expect(items).toEqual(['Increase storage', 'FailoverWho can run it: Role: admin', 'Delete database']);
    expect(screen.getByRole('menuitem', { name: /Failover/ }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('menuitem', { name: /Failover/ }).getAttribute('title')).toMatch(/^You cannot run this action\. Role: admin\. Ask one of them/);
    expect(screen.getByLabelText('Requires approval')).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: /Increase storage/ }));
    expect(onRun).toHaveBeenCalledWith(actions[0]);
  });

  it('renders nothing without day-2 or delete actions', () => {
    const { container } = renderUi(
      <EntityActionsMenu entity={entity(null)} actions={[action({ trigger: { on: 'create' } })]} user={alice} onRun={() => undefined} />,
    );
    expect(container.querySelector('[aria-label^="Actions on"]')).toBeNull();
  });
});
