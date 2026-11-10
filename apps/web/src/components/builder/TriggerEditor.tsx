import {
  ActionIcon,
  Button,
  Card,
  Group,
  Input,
  NumberInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconApi, IconBolt, IconCalendarTime, IconForms, IconPlus, IconTrash, IconWebhook } from '@tabler/icons-react';
import type { Action, BlackoutWindow, FormLikeTrigger, FormTrigger, ScheduleTrigger, WorkflowTrigger } from '@asterius/shared';
import { api } from '../../lib/api';
import type { FieldDraft } from './fields';
import { FieldsEditor } from './FieldsEditor';
import { KeyValueEditor, MONO_INPUT, SubjectsEditor } from './blocks';
import { ApprovalTimersEditor } from './ApprovalSettings';

/**
 * The trigger of a workflow. Only one kind today: a form submitted by a user, offered on the self-service page
 * (create) or in the "⋯" menu of an entity (day-2 / delete). Its fields become `inputs.*` for every step.
 */

export const TRIGGER_TYPES = {
  form: { label: 'Form submission', hint: 'A user fills a form on the self-service page or on a catalog entity', icon: IconForms },
  api: { label: 'API call', hint: 'Started by POST /actions/<id>/runs, with no page: for pipelines and scripts', icon: IconApi },
  schedule: { label: 'Schedule', hint: 'A cron expression in a time zone, one run per tick', icon: IconCalendarTime },
  event: { label: 'Catalog or run event', hint: 'An entity is created, updated or deleted, or another workflow finishes', icon: IconBolt },
  webhook: { label: 'Inbound webhook', hint: 'A third party POSTs to /api/v1/hooks/<id> with a shared secret or signature', icon: IconWebhook },
} as const;

export const isFormLike = (t: WorkflowTrigger | null | undefined): t is FormLikeTrigger => t?.type === 'form' || t?.type === 'api';

export const newFormTrigger = (): FormTrigger => ({
  type: 'form',
  on: 'create',
  blueprint: null,
  inputs: { properties: {} },
  allowed: {},
  approval: { required: false },
});

/** "Self-service · database" / "On a database entity" / "Every day at 03:00" */
export function triggerSummary(t: WorkflowTrigger) {
  if (t.type === 'schedule') return `${t.cron} (${t.timezone})${t.entities ? ` · each ${t.entities.blueprint}` : ''}`;
  if (t.type === 'event') return `On ${t.event}${t.blueprint ? ` · ${t.blueprint}` : ''}${t.action ? ` · ${t.action}` : ''}`;
  if (t.type === 'webhook') return 'POST /api/v1/hooks/…';
  if (t.type === 'api') return `API only${t.blueprint ? ` · ${t.blueprint}` : ''}`;
  if (t.on === 'create') return `Self-service page${t.blueprint ? ` · ${t.blueprint}` : ''}`;
  return `${t.on === 'delete' ? 'Delete' : 'Action'} on ${t.blueprint ? `a ${t.blueprint}` : 'an entity'}`;
}

/** A fresh trigger of another type; the blueprint carries over. */
export function triggerOfType(type: WorkflowTrigger['type'], from: WorkflowTrigger): WorkflowTrigger {
  const blueprint = 'blueprint' in from ? from.blueprint : null;
  switch (type) {
    case 'form':
    case 'api':
      return { ...newFormTrigger(), ...(isFormLike(from) ? from : { blueprint }), type } as FormLikeTrigger;
    case 'schedule':
      return { type, cron: '0 3 * * *', timezone: 'UTC', inputs: {} };
    case 'event':
      return { type, event: 'entity.created', blueprint, inputs: {} };
    case 'webhook':
      return { type, secret: '${secret:WEBHOOK_SECRET}', blueprint, inputs: {} };
  }
}

export function TriggerEditor(props: {
  trigger: WorkflowTrigger;
  onChange: (t: WorkflowTrigger) => void;
  fields: FieldDraft[];
  onFieldsChange: (f: FieldDraft[]) => void;
  onRemove: () => void;
  /** Action-level blackout windows (edited here: they govern when the trigger may start the workflow). */
  blackouts?: BlackoutWindow[];
  blackoutMode?: 'skip' | 'defer';
  /** Read-only status of the saved windows (active / next). */
  blackoutStatus?: Action['blackout'];
  onBlackoutsChange?: (patch: { blackouts?: BlackoutWindow[]; blackoutMode?: 'skip' | 'defer' }) => void;
}) {
  const { trigger, onChange, onBlackoutsChange } = props;
  return (
    <Stack gap="lg">
      <Select
        label="Trigger type"
        description={TRIGGER_TYPES[trigger.type].hint}
        allowDeselect={false}
        data={Object.entries(TRIGGER_TYPES).map(([value, t]) => ({ value, label: t.label }))}
        value={trigger.type}
        onChange={(t) => t && t !== trigger.type && onChange(triggerOfType(t as WorkflowTrigger['type'], trigger))}
      />
      {isFormLike(trigger) ? (
        <FormTriggerEditor {...props} trigger={trigger} onChange={onChange} />
      ) : (
        <>
          <AutomaticTriggerEditor trigger={trigger} onChange={onChange} />
          <Group justify="flex-end">
            <Button variant="subtle" color="red" leftSection={<IconTrash size={16} />} onClick={props.onRemove}>
              Remove trigger
            </Button>
          </Group>
        </>
      )}
      {onBlackoutsChange && (
        <BlackoutEditor
          windows={props.blackouts ?? []}
          mode={props.blackoutMode}
          status={props.blackoutStatus}
          automated={!isFormLike(trigger)}
          onChange={onBlackoutsChange}
        />
      )}
    </Stack>
  );
}

const newWindow = (): BlackoutWindow => ({ name: '', cron: '0 22 * * 5', duration: '60h', timezone: 'UTC' });

/** Blackout windows: recurring (cron start + duration) or fixed (from/to), and what automated triggers do meanwhile. */
export function BlackoutEditor({
  windows,
  mode,
  status,
  automated,
  onChange,
}: {
  windows: BlackoutWindow[];
  mode?: 'skip' | 'defer';
  status?: Action['blackout'];
  automated: boolean;
  onChange: (patch: { blackouts?: BlackoutWindow[]; blackoutMode?: 'skip' | 'defer' }) => void;
}) {
  const set = (list: BlackoutWindow[]) => onChange({ blackouts: list.length ? list : undefined, blackoutMode: list.length ? mode : undefined });
  const edit = (i: number, patch: Partial<BlackoutWindow>) => set(windows.map((w, j) => (j === i ? { ...w, ...patch } : w)));
  return (
    <Stack gap="sm">
      <div>
        <Title order={5}>Blackout windows</Title>
        <Text fz="xs" c="dimmed">
          No run starts during a window: form and API submissions are refused (admins may override), automated triggers skip or defer their runs.
        </Text>
        {status?.active && (
          <Text fz="xs" c="red">
            In effect now: {status.active.name}, until {new Date(status.active.until).toLocaleString()}
          </Text>
        )}
        {!status?.active && status?.next && (
          <Text fz="xs" c="dimmed">
            Next: {status.next.name}, {new Date(status.next.from).toLocaleString()} to {new Date(status.next.until).toLocaleString()}
          </Text>
        )}
      </div>
      {windows.map((w, i) => {
        const fixed = !w.cron && (w.from !== undefined || w.to !== undefined);
        return (
          <Card key={i} withBorder padding="sm">
            <Stack gap="xs">
              <Group gap="xs" wrap="nowrap" align="flex-end">
                <TextInput
                  label="Name"
                  placeholder="Weekend freeze"
                  flex={1}
                  value={w.name ?? ''}
                  onChange={(e) => edit(i, { name: e.currentTarget.value || undefined })}
                />
                <SegmentedControl
                  value={fixed ? 'fixed' : 'recurring'}
                  onChange={(v) =>
                    edit(
                      i,
                      v === 'fixed'
                        ? { cron: undefined, duration: undefined, from: new Date().toISOString(), to: new Date(Date.now() + 3_600_000).toISOString() }
                        : { cron: '0 22 * * 5', duration: '60h', from: undefined, to: undefined },
                    )
                  }
                  data={[
                    { value: 'recurring', label: 'Recurring' },
                    { value: 'fixed', label: 'Fixed dates' },
                  ]}
                />
                <ActionIcon variant="subtle" color="red" size="lg" onClick={() => set(windows.filter((_, j) => j !== i))} aria-label="Remove window">
                  <IconTrash size={16} />
                </ActionIcon>
              </Group>
              {fixed ? (
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <TextInput
                    label="From"
                    description="ISO date and time, e.g. 2026-12-24T18:00:00Z"
                    value={w.from ?? ''}
                    onChange={(e) => edit(i, { from: e.currentTarget.value })}
                    styles={MONO_INPUT}
                  />
                  <TextInput label="To" value={w.to ?? ''} onChange={(e) => edit(i, { to: e.currentTarget.value })} styles={MONO_INPUT} />
                </SimpleGrid>
              ) : (
                <SimpleGrid cols={{ base: 1, sm: 3 }}>
                  <TextInput label="Starts (cron)" value={w.cron ?? ''} onChange={(e) => edit(i, { cron: e.currentTarget.value })} styles={MONO_INPUT} />
                  <TextInput
                    label="Duration"
                    description="e.g. 30m, 2h, 1d, 1h30m"
                    value={w.duration ?? ''}
                    onChange={(e) => edit(i, { duration: e.currentTarget.value })}
                    styles={MONO_INPUT}
                  />
                  <TextInput label="Time zone" value={w.timezone} onChange={(e) => edit(i, { timezone: e.currentTarget.value })} />
                </SimpleGrid>
              )}
            </Stack>
          </Card>
        );
      })}
      <Group justify="space-between">
        <Button variant="subtle" color="gray" size="xs" leftSection={<IconPlus size={14} />} onClick={() => set([...windows, newWindow()])}>
          Add window
        </Button>
        {windows.length > 0 && automated && (
          <SegmentedControl
            size="xs"
            value={mode ?? 'skip'}
            onChange={(v) => onChange({ blackouts: windows, blackoutMode: v === 'defer' ? 'defer' : undefined })}
            data={[
              { value: 'skip', label: 'Skip runs during a window' },
              { value: 'defer', label: 'Defer them to its end' },
            ]}
          />
        )}
      </Group>
    </Stack>
  );
}

const EVENTS = ['entity.created', 'entity.updated', 'entity.deleted', 'entity.expired', 'scorecard.changed', 'run.finished'] as const;

/** Schedule, event and webhook triggers: settings plus the mapping of the context to the run inputs. */
function AutomaticTriggerEditor({ trigger, onChange }: { trigger: Exclude<WorkflowTrigger, FormLikeTrigger>; onChange: (t: WorkflowTrigger) => void }) {
  const blueprints = useQuery({ queryKey: ['blueprints'], queryFn: api.blueprints, staleTime: 30_000 });
  const actions = useQuery({ queryKey: ['actions', 'all'], queryFn: () => api.actions(), enabled: trigger.type === 'event' });
  const bpData = (blueprints.data ?? []).map((b) => ({ value: b.identifier, label: b.title }));
  const ctxHint = {
    schedule: trigger.type === 'schedule' && trigger.entities ? 'schedule.at, entity.identifier, entity.properties.<name>' : 'schedule.at',
    event: 'event.entity.identifier, event.entity.properties.<name>, event.run.id',
    webhook: 'body.<field>, headers.<name>, query.<name>',
  }[trigger.type];
  return (
    <Stack gap="sm">
      {trigger.type === 'schedule' && (
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput
            label="Cron"
            description="minute hour day-of-month month day-of-week, e.g. 0 3 * * 1-5"
            value={trigger.cron}
            onChange={(e) => onChange({ ...trigger, cron: e.currentTarget.value })}
            styles={MONO_INPUT}
          />
          <TextInput
            label="Time zone"
            description="IANA name, e.g. Europe/Paris"
            value={trigger.timezone}
            onChange={(e) => onChange({ ...trigger, timezone: e.currentTarget.value })}
          />
          <Select
            label="Missed ticks"
            description="When no worker ran at tick time (downtime, upgrade)"
            allowDeselect={false}
            data={[
              { value: 'none', label: 'Run the oldest once, drop the others' },
              { value: 'last', label: 'Run the most recent once' },
              { value: 'all', label: 'Run each (last 7 days, bounded)' },
            ]}
            value={trigger.catchUp ?? 'none'}
            onChange={(v) =>
              onChange({
                ...trigger,
                catchUp: v === 'none' ? undefined : (v as ScheduleTrigger['catchUp']),
                maxCatchUp: v === 'all' ? trigger.maxCatchUp : undefined,
              })
            }
          />
          {trigger.catchUp === 'all' && (
            <NumberInput
              label="At most (most recent ticks)"
              min={1}
              max={100}
              placeholder="10"
              value={trigger.maxCatchUp ?? ''}
              onChange={(n) => onChange({ ...trigger, maxCatchUp: typeof n === 'number' ? n : undefined })}
            />
          )}
        </SimpleGrid>
      )}
      {trigger.type === 'schedule' && <FanOutEditor trigger={trigger} onChange={onChange} blueprints={bpData} />}
      {trigger.type === 'event' && (
        <>
          <Select
            label="Event"
            allowDeselect={false}
            data={[...EVENTS]}
            value={trigger.event}
            onChange={(v) => v && onChange({ ...trigger, event: v as (typeof EVENTS)[number] })}
          />
          {trigger.event === 'run.finished' ? (
            <Select
              label="Workflow"
              searchable
              clearable
              placeholder="Any workflow"
              data={(actions.data ?? []).map((a) => ({ value: a.identifier, label: a.title }))}
              value={trigger.action ?? null}
              onChange={(v) => onChange({ ...trigger, action: v })}
            />
          ) : (
            <Select
              label="Blueprint"
              searchable
              clearable
              placeholder="Any blueprint"
              data={bpData}
              value={trigger.blueprint ?? null}
              onChange={(v) => onChange({ ...trigger, blueprint: v })}
            />
          )}
          <TextInput
            label="Filter (JSONata, optional)"
            description='e.g. event.entity.properties.tier = "gold"'
            value={trigger.filter ?? ''}
            onChange={(e) => onChange({ ...trigger, filter: e.currentTarget.value || undefined })}
            styles={MONO_INPUT}
          />
        </>
      )}
      {trigger.type === 'webhook' && (
        <>
          <TextInput
            label="Secret"
            description="A secret reference. Callers send it as X-Asterius-Token, or sign the body when a signature header is set"
            value={trigger.secret}
            onChange={(e) => onChange({ ...trigger, secret: e.currentTarget.value })}
            styles={MONO_INPUT}
          />
          <TextInput
            label="Signature header (optional)"
            description="e.g. X-Hub-Signature-256: HMAC-SHA256 of the body with the secret"
            value={trigger.signatureHeader ?? ''}
            onChange={(e) => onChange({ ...trigger, signatureHeader: e.currentTarget.value || undefined })}
          />
          <Select
            label="Blueprint (optional)"
            searchable
            clearable
            data={bpData}
            value={trigger.blueprint ?? null}
            onChange={(v) => onChange({ ...trigger, blueprint: v })}
          />
        </>
      )}
      {trigger.type !== 'schedule' && trigger.blueprint && (
        <TextInput
          label="Entity (template)"
          placeholder={trigger.type === 'event' ? '{{ event.entity.identifier }} (default)' : '{{ body.name }}'}
          value={trigger.entity ?? ''}
          onChange={(e) => onChange({ ...trigger, entity: e.currentTarget.value || undefined })}
          styles={MONO_INPUT}
        />
      )}
      <Input.Wrapper label="Run inputs" description={`Templates over ${ctxHint}; steps read them as inputs.<name>`}>
        <KeyValueEditor
          value={trigger.inputs}
          onChange={(inputs) => onChange({ ...trigger, inputs })}
          keyPlaceholder="input"
          valuePlaceholder="value or {{ template }}"
        />
      </Input.Wrapper>
    </Stack>
  );
}

/** Scheduled fan-out: one run per matching entity of a blueprint on every tick. */
function FanOutEditor({
  trigger,
  onChange,
  blueprints,
}: {
  trigger: ScheduleTrigger;
  onChange: (t: WorkflowTrigger) => void;
  blueprints: { value: string; label: string }[];
}) {
  const f = trigger.entities;
  const set = (patch: Partial<NonNullable<ScheduleTrigger['entities']>>) => onChange({ ...trigger, entities: { blueprint: '', ...f, ...patch } });
  return (
    <Stack gap="xs">
      <Switch
        label="Run once per entity"
        description="On each tick, one run per matching entity of a blueprint (like an action on each entity)"
        checked={!!f}
        onChange={(e) => onChange({ ...trigger, entities: e.currentTarget.checked ? { blueprint: blueprints[0]?.value ?? '' } : undefined })}
      />
      {f && (
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <Select
            label="Blueprint"
            searchable
            allowDeselect={false}
            data={blueprints}
            value={f.blueprint || null}
            onChange={(v) => v && set({ blueprint: v })}
          />
          <TextInput
            label="Filter (JSONata, optional)"
            placeholder='entity.properties.env = "prod"'
            value={f.filter ?? ''}
            onChange={(e) => set({ filter: e.currentTarget.value || undefined })}
            styles={MONO_INPUT}
          />
          <NumberInput
            label="At most per tick"
            min={1}
            max={1000}
            placeholder="200"
            value={f.limit ?? ''}
            onChange={(n) => set({ limit: typeof n === 'number' ? n : undefined })}
          />
        </SimpleGrid>
      )}
    </Stack>
  );
}

function FormTriggerEditor({
  trigger,
  onChange,
  fields,
  onFieldsChange,
  onRemove,
}: {
  trigger: FormLikeTrigger;
  onChange: (t: WorkflowTrigger) => void;
  fields: FieldDraft[];
  onFieldsChange: (f: FieldDraft[]) => void;
  onRemove: () => void;
}) {
  const blueprints = useQuery({ queryKey: ['blueprints'], queryFn: api.blueprints, staleTime: 30_000 });
  const set = (patch: Partial<FormTrigger>) => onChange({ ...trigger, ...patch } as FormLikeTrigger);
  const onEntity = trigger.on !== 'create';
  const approval = trigger.approval;

  return (
    <Stack gap="lg">
      <Stack gap="sm">
        <Title order={5}>Where the form is offered</Title>
        <SegmentedControl
          value={trigger.on}
          onChange={(on) => set({ on: on as FormTrigger['on'] })}
          data={[
            { value: 'create', label: 'Self-service page' },
            { value: 'day-2', label: 'On an entity' },
            { value: 'delete', label: 'On an entity (delete)' },
          ]}
        />
        <Select
          label="Blueprint"
          description={onEntity ? 'The kind of entity it runs on (its "⋯" menu)' : 'Optional: groups it on the self-service page and the catalog'}
          withAsterisk={onEntity}
          searchable
          clearable={!onEntity}
          placeholder={onEntity ? 'Choose a blueprint' : 'None (general)'}
          data={(blueprints.data ?? []).map((b) => ({ value: b.identifier, label: b.title }))}
          value={trigger.blueprint ?? null}
          onChange={(b) => set({ blueprint: b })}
          error={onEntity && !trigger.blueprint ? 'Required for forms on an entity' : undefined}
        />
      </Stack>

      <Stack gap="sm">
        <div>
          <Title order={5}>Form fields</Title>
          <Text fz="xs" c="dimmed">
            What the user fills in; steps read them as <code>{'{{ inputs.<name> }}'}</code>. A form may have no field (a button).
          </Text>
        </div>
        <FieldsEditor fields={fields} onChange={onFieldsChange} />
      </Stack>

      <Stack gap="sm">
        <Title order={5}>Who can submit it</Title>
        <SubjectsEditor value={trigger.allowed} onChange={(allowed) => set({ allowed })} allowOwnerTeam={onEntity} emptyMeans="every signed-in user" />
      </Stack>

      <Stack gap="sm">
        <Switch
          label={<Title order={5}>Require approval before the workflow starts</Title>}
          description="For an approval in the middle of the workflow (e.g. after an AI review), add an Approval step instead"
          checked={approval.required}
          onChange={(e) => set({ approval: { ...approval, required: e.currentTarget.checked } })}
        />
        {approval.required && (
          <>
            <SubjectsEditor
              value={approval.approvers}
              onChange={(approvers) => set({ approval: { ...approval, approvers } })}
              allowOwnerTeam={onEntity}
              emptyMeans="admins approve"
            />
            <Group align="flex-end">
              <NumberInput
                label="Approvals needed"
                min={1}
                max={10}
                w={180}
                value={approval.minApprovals ?? 1}
                onChange={(n) => set({ approval: { ...approval, minApprovals: Number(n) || 1 } })}
              />
              <Switch
                mb="xs"
                label="Requesters may approve their own requests"
                checked={!!approval.allowSelfApproval}
                onChange={(e) => set({ approval: { ...approval, allowSelfApproval: e.currentTarget.checked } })}
              />
            </Group>
            <TextInput
              label="Expires after"
              description="Without enough approvals by then (e.g. 7d); empty: never"
              w={260}
              value={approval.expireAfter ?? ''}
              onChange={(e) => {
                const expireAfter = e.currentTarget.value || undefined;
                set({ approval: { ...approval, expireAfter, ...(expireAfter ? {} : { onExpiry: undefined }) } });
              }}
            />
            <ApprovalTimersEditor
              value={approval}
              onChange={(p) => set({ approval: { ...approval, ...p } })}
              onEntity={onEntity}
              expiryHint={approval.expireAfter ? `After ${approval.expireAfter}` : 'Set "Expires after" first'}
            />
          </>
        )}
      </Stack>

      <Group justify="flex-end">
        <Button variant="subtle" color="red" leftSection={<IconTrash size={16} />} onClick={onRemove}>
          Remove trigger
        </Button>
      </Group>
    </Stack>
  );
}
