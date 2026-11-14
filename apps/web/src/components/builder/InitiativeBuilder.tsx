import { Alert, Autocomplete, MultiSelect, NumberInput, Select, SimpleGrid, Stack, Switch, Text, Textarea, TextInput } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconCalendarEvent, IconFlag, IconTarget } from '@tabler/icons-react';
import type { Scorecard } from '@asterius/shared';
import { api } from '../../lib/api';
import { FormBuilder, identityProblems, IdentityFields, SLUG, type EditorProps } from './FormBuilder';

/** Form editor of scorecard initiatives: a scorecard goal (level and/or rules), dates, scope and reminders. */

export interface InitiativeDoc {
  identifier: string;
  title: string;
  description: string;
  scorecard: string;
  targetLevel: string | null;
  rules: string[];
  startDate: string;
  deadline: string;
  teams: string[];
  /** '' while none. */
  owner: string;
  enabled: boolean;
  reminderDays: number;
  [k: string]: unknown;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

export const toInitiativeDoc = (v: Record<string, unknown>): InitiativeDoc => ({
  ...v,
  identifier: String(v.identifier ?? ''),
  title: String(v.title ?? ''),
  description: String(v.description ?? ''),
  scorecard: String(v.scorecard ?? ''),
  targetLevel: typeof v.targetLevel === 'string' && v.targetLevel ? v.targetLevel : null,
  rules: strings(v.rules),
  startDate: String(v.startDate ?? ''),
  deadline: String(v.deadline ?? ''),
  teams: strings(v.teams),
  owner: typeof v.owner === 'string' ? v.owner : '',
  enabled: v.enabled !== false,
  reminderDays: typeof v.reminderDays === 'number' ? v.reminderDays : 7,
});

export const initiativeBody = (d: InitiativeDoc): Record<string, unknown> => ({
  ...d,
  targetLevel: d.targetLevel || null,
  owner: d.owner.trim() ? d.owner.trim().toLowerCase() : null,
});

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day as YYYY-MM-DD (2026-02-30 is not). */
export const isDay = (s: string) => DAY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Mirrors `initiativeDef`; with the scorecard loaded, also checks that the level and rules exist in it. */
export function initiativeProblems(d: InitiativeDoc, scorecard?: Scorecard): string[] {
  const out = identityProblems(d);
  if (!SLUG.test(d.scorecard)) out.push('Scorecard is required');
  if (!d.targetLevel && !d.rules.length) out.push('Set a target level, rules, or both');
  if (scorecard) {
    if (d.targetLevel && !scorecard.levels.some((l) => l.name === d.targetLevel)) out.push(`Level "${d.targetLevel}" is not defined by ${scorecard.title}`);
    const known = new Set(scorecard.rules.map((r) => r.identifier));
    for (const r of d.rules) if (!known.has(r)) out.push(`Rule "${r}" is not defined by ${scorecard.title}`);
  }
  if (!isDay(d.startDate)) out.push('Start date: a valid date (YYYY-MM-DD) is required');
  if (!isDay(d.deadline)) out.push('Deadline: a valid date (YYYY-MM-DD) is required');
  if (isDay(d.startDate) && isDay(d.deadline) && d.deadline < d.startDate) out.push('The deadline must not be before the start date');
  if (d.owner.trim() && !EMAIL.test(d.owner.trim())) out.push('Owner: a valid email address');
  if (!Number.isInteger(d.reminderDays) || d.reminderDays < 0 || d.reminderDays > 90) out.push('Reminders: a whole number of days between 0 and 90');
  return out;
}

/** Keeps the level and rules the new scorecard also defines. */
export function followScorecard(d: InitiativeDoc, scorecard: Scorecard | undefined): Partial<InitiativeDoc> {
  if (!scorecard) return { targetLevel: null, rules: [] };
  const rules = new Set(scorecard.rules.map((r) => r.identifier));
  return {
    targetLevel: d.targetLevel && scorecard.levels.some((l) => l.name === d.targetLevel) ? d.targetLevel : null,
    rules: d.rules.filter((r) => rules.has(r)),
  };
}

const list = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** "Entities of service owned by core must reach Silver and pass Has docs by 2026-06-30." */
export function goalSentence(d: InitiativeDoc, scorecard: Scorecard | undefined): string | null {
  if (!scorecard || (!d.targetLevel && !d.rules.length)) return null;
  const title = (id: string) => scorecard.rules.find((r) => r.identifier === id)?.title ?? id;
  const goal = [d.targetLevel ? `reach ${d.targetLevel}` : null, d.rules.length ? `pass ${list(d.rules.map(title))}` : null].filter(Boolean).join(' and ');
  const scope = d.teams.length ? ` owned by ${list(d.teams)}` : '';
  const by = isDay(d.deadline) ? ` by ${d.deadline}` : '';
  return `Entities of ${scorecard.blueprint}${scope} must ${goal}${by}.`;
}

export function InitiativeBuilder(props: EditorProps) {
  const scorecards = useQuery({ queryKey: ['scorecards'], queryFn: () => api.scorecards() });
  const teams = useQuery({ queryKey: ['teams'], queryFn: api.teams, staleTime: 60_000 });
  const users = useQuery({ queryKey: ['user-lookup'], queryFn: api.userLookup, staleTime: 60_000 });
  const find = (id: string) => scorecards.data?.find((s) => s.identifier === id);
  return (
    <FormBuilder<InitiativeDoc>
      {...props}
      size="xl"
      noun="initiative"
      toDoc={toInitiativeDoc}
      toBody={initiativeBody}
      problems={(d) => initiativeProblems(d, find(d.scorecard))}
      tabs={[
        {
          value: 'initiative',
          label: 'Initiative',
          icon: <IconFlag size={16} />,
          render: (ctx) => (
            <Stack gap="md">
              <IdentityFields {...ctx} placeholder="Every service at Silver" />
              <Textarea
                label="Description"
                description="Why it matters and how to fix failing entities; shown on the initiative page"
                autosize
                minRows={2}
                value={ctx.doc.description}
                onChange={(e) => ctx.set({ description: e.currentTarget.value })}
              />
              <Switch
                label="Enabled"
                description="Disabled initiatives are hidden from the list, To do and reminders"
                checked={ctx.doc.enabled}
                onChange={(e) => ctx.set({ enabled: e.currentTarget.checked })}
              />
            </Stack>
          ),
        },
        {
          value: 'goal',
          label: 'Goal',
          icon: <IconTarget size={16} />,
          render: ({ doc, set }) => {
            const sc = find(doc.scorecard);
            const options = (scorecards.data ?? []).map((s) => ({ value: s.identifier, label: `${s.title} (${s.blueprint})` }));
            if (doc.scorecard && !sc) options.unshift({ value: doc.scorecard, label: doc.scorecard });
            const levels = sc?.levels.map((l) => l.name) ?? [];
            const known = new Set(sc?.rules.map((r) => r.identifier) ?? []);
            const ruleData = [
              ...levels
                .map((level) => ({
                  group: level,
                  items: sc!.rules.filter((r) => r.level === level).map((r) => ({ value: r.identifier, label: `${r.title} (${r.identifier})` })),
                }))
                .filter((g) => g.items.length),
              ...(doc.rules.some((r) => !known.has(r)) ? [{ group: 'Not in this scorecard', items: doc.rules.filter((r) => !known.has(r)) }] : []),
            ];
            const levelData = [...new Set([...levels, ...(doc.targetLevel ? [doc.targetLevel] : [])])];
            // Rules already required by the target level (its own and those below).
            const upTo = doc.targetLevel ? levels.slice(0, levels.indexOf(doc.targetLevel) + 1) : [];
            const implied = sc && upTo.length ? doc.rules.filter((id) => upTo.includes(sc.rules.find((r) => r.identifier === id)?.level ?? '')) : [];
            const sentence = goalSentence(doc, sc);
            return (
              <Stack gap="md">
                <Select
                  label="Scorecard"
                  withAsterisk
                  searchable
                  allowDeselect={false}
                  description="Its blueprint gives the entities in scope"
                  placeholder={scorecards.isPending ? 'Loading…' : 'Pick a scorecard'}
                  data={options}
                  value={doc.scorecard || null}
                  onChange={(id) => set({ scorecard: id ?? '', ...followScorecard(doc, id ? find(id) : undefined) })}
                  error={doc.scorecard && scorecards.data && !sc ? 'Not found' : undefined}
                />
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <Select
                    label="Target level"
                    description="Done at this level or above"
                    placeholder={sc ? 'No level' : 'Pick a scorecard first'}
                    clearable
                    disabled={!sc && !doc.targetLevel}
                    data={levelData}
                    value={doc.targetLevel}
                    onChange={(l) => set({ targetLevel: l || null })}
                    error={doc.targetLevel && sc && !levels.includes(doc.targetLevel) ? 'not defined by this scorecard' : undefined}
                  />
                  <MultiSelect
                    label="Rules"
                    description="Must pass as well (in addition to the level)"
                    placeholder={sc ? (doc.rules.length ? undefined : 'No rule') : 'Pick a scorecard first'}
                    searchable
                    clearable
                    disabled={!sc && !doc.rules.length}
                    data={ruleData}
                    value={doc.rules}
                    onChange={(rules) => set({ rules })}
                  />
                </SimpleGrid>
                {implied.length > 0 && (
                  <Text fz="xs" c="dimmed">
                    Already required by {doc.targetLevel}: {implied.join(', ')}.
                  </Text>
                )}
                {sentence ? (
                  <Alert variant="light" color="blue" title="Done means" p="xs">
                    <Text fz="sm">{sentence}</Text>
                  </Alert>
                ) : (
                  <Text fz="sm" c="dimmed">
                    Pick a scorecard, then a target level, rules, or both.
                  </Text>
                )}
              </Stack>
            );
          },
        },
        {
          value: 'schedule',
          label: 'Schedule and scope',
          icon: <IconCalendarEvent size={16} />,
          render: ({ doc, set }) => {
            const bad = isDay(doc.startDate) && isDay(doc.deadline) && doc.deadline < doc.startDate;
            const teamData = [
              ...(teams.data ?? []).map((t) => ({ value: t.identifier, label: t.title })),
              ...doc.teams.filter((t) => !teams.data?.some((x) => x.identifier === t)).map((t) => ({ value: t, label: t })),
            ];
            const emails = [...new Set((users.data ?? []).map((u) => u.email))];
            return (
              <Stack gap="md">
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <TextInput
                    label="Start date"
                    type="date"
                    withAsterisk
                    description="Progress is expected to grow linearly from here"
                    value={doc.startDate}
                    onChange={(e) => set({ startDate: e.currentTarget.value })}
                    error={doc.startDate && !isDay(doc.startDate) ? 'YYYY-MM-DD' : undefined}
                  />
                  <TextInput
                    label="Deadline"
                    type="date"
                    withAsterisk
                    description="Overdue after this day"
                    value={doc.deadline}
                    min={isDay(doc.startDate) ? doc.startDate : undefined}
                    onChange={(e) => set({ deadline: e.currentTarget.value })}
                    error={doc.deadline && !isDay(doc.deadline) ? 'YYYY-MM-DD' : bad ? 'Before the start date' : undefined}
                  />
                </SimpleGrid>
                <MultiSelect
                  label="Teams"
                  description="Only the entities owned by these teams; empty: every entity of the blueprint"
                  placeholder={doc.teams.length ? undefined : 'Every team'}
                  searchable
                  clearable
                  data={teamData}
                  value={doc.teams}
                  onChange={(t) => set({ teams: t })}
                />
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <Autocomplete
                    label="Owner"
                    description="Accountable person; may grant exemptions and gets the reminders"
                    placeholder="name@example.com"
                    data={emails}
                    value={doc.owner}
                    onChange={(owner) => set({ owner })}
                    error={doc.owner.trim() && !EMAIL.test(doc.owner.trim()) ? 'Not an email address' : undefined}
                  />
                  <NumberInput
                    label="Remind every (days)"
                    description="Teams with failing entities and the owner; 0: never"
                    min={0}
                    max={90}
                    allowDecimal={false}
                    allowNegative={false}
                    value={doc.reminderDays}
                    onChange={(n) => set({ reminderDays: typeof n === 'number' ? n : Number.NaN })}
                    error={doc.reminderDays > 90 ? 'At most 90' : undefined}
                  />
                </SimpleGrid>
              </Stack>
            );
          },
        },
      ]}
    />
  );
}
