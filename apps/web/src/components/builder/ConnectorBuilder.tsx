import type { ReactNode } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Code,
  Group,
  Input,
  MultiSelect,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  TagsInput,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import {
  IconArrowDown,
  IconArrowUp,
  IconBolt,
  IconForms,
  IconHeartbeat,
  IconKey,
  IconListDetails,
  IconPlus,
  IconTrash,
  IconWritingSign,
} from '@tabler/icons-react';
import type { AuthType, ConnectorPagination, HttpMethod } from '@asterius/shared';
import { ICON } from '@asterius/brand';
import { AUTH_FIELDS, AUTH_LABELS, authInputs, CATEGORY_LABELS } from '../../lib/connectors';
import { IconPicker } from '../IconPicker';
import { Caption, Empty } from '../ui';
import { JsonEditor, KeyValueEditor, MONO_INPUT } from './blocks';
import { ExpressionStatus } from './ExpressionTools';
import { ACTION_FIELDS, FieldsEditor } from './FieldsEditor';
import { emptyField, type FieldDraft } from './fields';
import { FormBuilder, IdentityFields, type EditorProps, type FormContext } from './FormBuilder';
import { slugify } from './shell';
import {
  authBody,
  BASE_URL,
  CATEGORIES,
  connectorBody,
  connectorProblems,
  METHODS,
  newAuth,
  newKind,
  newOperation,
  newPoll,
  newTest,
  PAGINATION_TYPES,
  pathProblem,
  toConnectorDoc,
  type AuthDraft,
  type ConnectorDoc,
  type KindDraft,
  type OperationDraft,
  type PollDraft,
  type RequestDraft,
} from './connectorDoc';

/**
 * Form editor of a connector definition (Admin → Connectors): identity, the connection form, authentication methods,
 * shared headers and the test request, the kinds integrations list and the operations workflows call. JSON / YAML
 * views from FormBuilder. Body templates stay JSON; everything with a fixed shape has its own fields.
 */

type Ctx = FormContext<ConnectorDoc>;

const move = <T,>(list: T[], i: number, by: number): T[] => {
  const j = i + by;
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
};
const replaceAt = <T,>(list: T[], i: number, item: T) => list.map((x, j) => (j === i ? item : x));

function ItemCard({
  heading,
  badges,
  i,
  count,
  label,
  onMove,
  onRemove,
  children,
}: {
  heading: ReactNode;
  badges?: ReactNode;
  i: number;
  count: number;
  label: string;
  onMove: (by: number) => void;
  onRemove: () => void;
  children: ReactNode;
}) {
  return (
    <Card withBorder shadow="none" radius="lg" padding="md">
      <Group justify="space-between" mb="xs" wrap="nowrap">
        <Group gap="xs">
          <Text fz="sm" fw={600}>
            {heading}
          </Text>
          {badges}
        </Group>
        <Group gap="4xs" wrap="nowrap">
          <ActionIcon variant="subtle" color="gray" aria-label={`Move ${label} up`} disabled={i === 0} onClick={() => onMove(-1)}>
            <IconArrowUp size={ICON.md} />
          </ActionIcon>
          <ActionIcon variant="subtle" color="gray" aria-label={`Move ${label} down`} disabled={i === count - 1} onClick={() => onMove(1)}>
            <IconArrowDown size={ICON.md} />
          </ActionIcon>
          <ActionIcon variant="subtle" color="red" aria-label={`Remove ${label}`} onClick={onRemove}>
            <IconTrash size={ICON.md} />
          </ActionIcon>
        </Group>
      </Group>
      <Stack gap="sm">{children}</Stack>
    </Card>
  );
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Group>
      <Button variant="light" color="gray" c="var(--mantine-color-text)" leftSection={<IconPlus size={ICON.md} />} onClick={onClick}>
        {label}
      </Button>
    </Group>
  );
}

function Labelled({ label, description, children }: { label: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Input.Wrapper label={label} description={description}>
      <Stack mt="2xs">{children}</Stack>
    </Input.Wrapper>
  );
}

/** A JSONata expression, checked live by the server. */
function ExpressionInput({
  label,
  description,
  value,
  onChange,
  required,
  placeholder,
}: {
  label: string;
  description?: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <Stack gap="4xs">
      <TextInput
        label={label}
        description={description}
        withAsterisk={required}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        styles={MONO_INPUT}
      />
      <ExpressionStatus expression={value} />
    </Stack>
  );
}

/** Method, path, query, headers and (for writes) the JSON body of one request. */
function RequestFields<R extends RequestDraft>({ value, onChange, name, body = true }: { value: R; onChange: (r: R) => void; name: string; body?: boolean }) {
  const set = (patch: Partial<RequestDraft>) => onChange({ ...value, ...patch });
  return (
    <Stack gap="sm">
      <Group align="flex-start" wrap="nowrap">
        <Select
          w={120}
          label="Method"
          aria-label={`${name} method`}
          data={METHODS}
          value={value.method}
          allowDeselect={false}
          onChange={(m) => m && set({ method: m as HttpMethod })}
        />
        <TextInput
          flex={1}
          label="Path"
          aria-label={`${name} path`}
          withAsterisk
          description="Relative to the connection's baseUrl; {{ connection.x }} and {{ inputs.x }} are URL-encoded"
          placeholder="/items/{{ inputs.id }}"
          value={value.path}
          error={value.path ? pathProblem(value.path) : undefined}
          onChange={(e) => set({ path: e.currentTarget.value })}
          styles={MONO_INPUT}
        />
      </Group>
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Labelled label="Query" description="Values are templates; a value that renders empty is left out">
          <KeyValueEditor value={value.query} onChange={(q) => set({ query: q as Record<string, string> })} keyPlaceholder="parameter" />
        </Labelled>
        <Labelled label="Headers" description="Never credentials: those come from the connection's authentication">
          <KeyValueEditor value={value.headers} onChange={(h) => set({ headers: h as Record<string, string> })} keyPlaceholder="Header-Name" />
        </Labelled>
      </SimpleGrid>
      {body && (value.method !== 'GET' || value.body !== undefined) && (
        <JsonEditor
          label="Body"
          description={'JSON; strings are templates, and "{{ expr }}" alone keeps the value\'s type. Empty: no body.'}
          value={value.body}
          onChange={(b) => set({ body: b })}
        />
      )}
    </Stack>
  );
}

// ---------- General ----------

function GeneralTab(ctx: Ctx) {
  const { doc, set } = ctx;
  return (
    <Stack gap="md">
      <IdentityFields {...ctx} placeholder="My tool" />
      <Textarea
        label="Description"
        description="What this system is and what the connector reads and does"
        autosize
        minRows={2}
        value={doc.description}
        onChange={(e) => set({ description: e.currentTarget.value })}
      />
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <IconPicker value={doc.icon} onChange={(icon) => set({ icon })} description="Shown on connector and connection cards" />
        <Select
          label="Category"
          data={CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))}
          value={doc.category}
          allowDeselect={false}
          onChange={(c) => c && set({ category: c as ConnectorDoc['category'] })}
        />
      </SimpleGrid>
      <Alert color="gray" variant="light">
        <Text fz="sm">
          Templates are <Code>{'{{ }}'}</Code> JSONata over <Code>connection</Code> (the connection form), <Code>inputs</Code> (operations) and{' '}
          <Code>output</Code> (polling). Never put credentials here: connections hold them as secret references.
        </Text>
      </Alert>
    </Stack>
  );
}

// ---------- Connection form ----------

const CONNECTION_FIELDS = { ...ACTION_FIELDS, templatePath: (n: string) => `connection.${n}`, emptyHint: 'The connection form only asks for the API URL.' };

function BaseUrlCard({ field, onChange }: { field: FieldDraft; onChange: (f: FieldDraft) => void }) {
  const set = (patch: Partial<FieldDraft>) => onChange({ ...field, ...patch });
  return (
    <Card withBorder shadow="none" radius="lg" padding="md">
      <Group gap="xs" mb="xs">
        <Text fz="sm" fw={600}>
          API URL
        </Text>
        <Code>baseUrl</Code>
        <Badge size="xs" variant="light" color="gray">
          always present
        </Badge>
      </Group>
      <Stack gap="xs">
        <Caption>Every request is relative to it. Give SaaS endpoints a default so connections do not have to type it.</Caption>
        <Group grow align="flex-start">
          <TextInput label="Label" aria-label="baseUrl label" value={field.label} onChange={(e) => set({ label: e.currentTarget.value })} />
          <Select
            label="Type"
            aria-label="baseUrl type"
            data={[
              { value: 'url', label: 'URL' },
              { value: 'text', label: 'Text' },
            ]}
            value={field.type === 'url' ? 'url' : 'text'}
            allowDeselect={false}
            onChange={(t) => t && set({ type: t as FieldDraft['type'] })}
          />
        </Group>
        <Group grow align="flex-start">
          <TextInput
            label="Default"
            aria-label="baseUrl default"
            placeholder="https://api.example.com"
            value={typeof field.defaultValue === 'string' ? field.defaultValue : ''}
            onChange={(e) => set({ defaultValue: e.currentTarget.value || undefined })}
            styles={MONO_INPUT}
          />
          <TextInput label="Help text" aria-label="baseUrl help" value={field.description} onChange={(e) => set({ description: e.currentTarget.value })} />
        </Group>
        <Checkbox label="Required" checked={field.required} onChange={(e) => set({ required: e.currentTarget.checked })} />
      </Stack>
    </Card>
  );
}

function FieldsTab({ doc, set }: Ctx) {
  const at = doc.fields.findIndex((f) => f.name === BASE_URL);
  const base = at >= 0 ? doc.fields[at] : undefined;
  const others = doc.fields.filter((_, i) => i !== at);
  const setOthers = (next: FieldDraft[]) => {
    if (!base) return set({ fields: next });
    const all = [...next];
    all.splice(Math.min(at, all.length), 0, base);
    set({ fields: all });
  };
  return (
    <Stack gap="md">
      <Caption>
        What a connection of this connector fills in, as <Code>{'{{ connection.<key> }}'}</Code> in templates. Credentials do not go here: they belong to
        Authentication.
      </Caption>
      {base ? (
        <BaseUrlCard field={base} onChange={(f) => set({ fields: replaceAt(doc.fields, at, f) })} />
      ) : (
        <Alert color="orange" variant="light" title="No baseUrl field">
          <Stack gap="xs">
            <Text fz="sm">A connector must declare a text field named baseUrl: the API URL every request is relative to.</Text>
            <Group>
              <Button
                size="xs"
                variant="light"
                onClick={() => set({ fields: [{ ...emptyField('url'), name: BASE_URL, label: 'API URL', required: true }, ...doc.fields] })}
              >
                Add the baseUrl field
              </Button>
            </Group>
          </Stack>
        </Alert>
      )}
      <FieldsEditor fields={others} onChange={setOthers} mode={CONNECTION_FIELDS} />
    </Stack>
  );
}

// ---------- Authentication ----------

const AUTH_TYPE_OPTIONS = (Object.keys(AUTH_LABELS) as AuthType[]).map((t) => ({ value: t, label: AUTH_LABELS[t] }));

function AuthCard({ m, onChange }: { m: AuthDraft; onChange: (m: AuthDraft) => void }) {
  const set = (patch: Partial<AuthDraft>) => onChange({ ...m, ...patch });
  const supplies = authInputs(authBody(m) as never);
  const known = AUTH_FIELDS[m.type].map((f) => f.key);
  return (
    <>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Select
          label="Type"
          aria-label="Authentication type"
          data={AUTH_TYPE_OPTIONS}
          value={m.type}
          allowDeselect={false}
          onChange={(t) => t && set({ type: t as AuthType, set: {}, headers: t === 'header' ? { 'X-API-Key': '{apiKey}' } : {} })}
        />
        <TextInput
          label="Title"
          aria-label="Authentication title"
          placeholder={AUTH_LABELS[m.type]}
          value={m.title}
          onChange={(e) => set({ title: e.currentTarget.value })}
        />
      </SimpleGrid>
      <TextInput
        label="Description"
        description="Where to create the credential, which scopes it needs…"
        value={m.description}
        onChange={(e) => set({ description: e.currentTarget.value })}
      />
      {m.type === 'header' && (
        <Labelled
          label="Headers sent"
          description={
            <>
              Header name → format; <Code>{'{name}'}</Code> placeholders are credentials the connection supplies, e.g. <Code>{'Token token={token}'}</Code>
            </>
          }
        >
          <KeyValueEditor
            key={`h-${m.type}`}
            value={m.headers}
            onChange={(h) => set({ headers: h as Record<string, string> })}
            keyPlaceholder="Header-Name"
            valuePlaceholder="{apiKey}"
          />
        </Labelled>
      )}
      <Labelled
        label="Set by the connector"
        description={
          <>
            Values connections do not choose ({known.length ? known.join(', ') : 'any key'}), e.g. a token <Code>scope</Code> or an empty Basic{' '}
            <Code>username</Code>; strings may use <Code>{'{{ connection.x }}'}</Code>
          </>
        }
      >
        <KeyValueEditor key={`s-${m.type}`} value={m.set} onChange={(s) => set({ set: s })} valuePlaceholder="value" />
      </Labelled>
      <TagsInput
        label="Extra credentials"
        description="Other auth values that hold credentials (connections must give references), e.g. a token sent as the Basic username"
        placeholder="Type a name and press Enter"
        value={m.secrets}
        onChange={(secrets) => set({ secrets })}
        styles={MONO_INPUT}
      />
      <Caption>Connections supply: {supplies.length ? supplies.map((f) => `${f.key}${f.secret ? ' (secret)' : ''}`).join(', ') : 'nothing'}</Caption>
    </>
  );
}

function AuthTab({ doc, set }: Ctx) {
  const auth = doc.auth;
  return (
    <Stack gap="sm">
      <Caption>The methods a connection chooses from, the first being the default. No method: the API needs no authentication.</Caption>
      {!auth.length && <Empty title="No authentication">Connections call the API anonymously.</Empty>}
      {auth.map((m, i) => (
        <ItemCard
          key={m.id}
          heading={m.title || AUTH_LABELS[m.type]}
          badges={
            i === 0 && (
              <Badge size="xs" variant="light" color="gray">
                default
              </Badge>
            )
          }
          i={i}
          count={auth.length}
          label={`method ${i + 1}`}
          onMove={(by) => set({ auth: move(auth, i, by) })}
          onRemove={() => set({ auth: auth.filter((x) => x.id !== m.id) })}
        >
          <AuthCard m={m} onChange={(next) => set({ auth: replaceAt(auth, i, next) })} />
        </ItemCard>
      ))}
      {auth.length < 10 && (
        <AddButton
          label="Add a method"
          onClick={() => set({ auth: [...auth, newAuth((Object.keys(AUTH_LABELS) as AuthType[]).find((t) => !auth.some((m) => m.type === t)))] })}
        />
      )}
      {auth.length > 0 && (
        <Switch
          label="Authentication is optional"
          description="Connections may leave it out (APIs readable anonymously)"
          checked={doc.authOptional}
          onChange={(e) => set({ authOptional: e.currentTarget.checked })}
        />
      )}
    </Stack>
  );
}

// ---------- Headers and test ----------

function HeadersTab({ doc, set }: Ctx) {
  const test = doc.test;
  return (
    <Stack gap="md">
      <Labelled label="Headers of every request" description="E.g. a vendor accept header; templates may use {{ connection.x }}">
        <KeyValueEditor value={doc.headers} onChange={(h) => set({ headers: h as Record<string, string> })} keyPlaceholder="Header-Name" />
      </Labelled>
      <Switch
        label="Test request"
        description='The request of "Test connection" on connections'
        checked={!!test}
        onChange={(e) => set({ test: e.currentTarget.checked ? newTest() : null })}
      />
      {test && (
        <Card withBorder shadow="none" radius="lg" padding="md">
          <Stack gap="sm">
            <RequestFields name="Test" value={test} onChange={(t) => set({ test: t })} body={false} />
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TagsInput
                label="Expected status"
                description="Empty: any 2xx"
                placeholder="200"
                value={test.status.map(String)}
                onChange={(v) => set({ test: { ...test, status: v.map(Number).filter((n) => !Number.isNaN(n)) } })}
              />
              <ExpressionInput
                label="Condition"
                description="JSONata over { status, body }: succeeds when truthy"
                placeholder="$exists(body.value)"
                value={test.condition}
                onChange={(condition) => set({ test: { ...test, condition } })}
              />
            </SimpleGrid>
          </Stack>
        </Card>
      )}
    </Stack>
  );
}

// ---------- Kinds ----------

function PaginationFields({ value, onChange }: { value: ConnectorPagination | null; onChange: (p: ConnectorPagination | null) => void }) {
  const p = value ?? { type: 'none' };
  const set = (patch: Partial<ConnectorPagination>) => onChange({ ...p, ...patch });
  const text = (k: 'param' | 'nextUrl' | 'totalPath' | 'cursorPath' | 'cursorHeader') => (v: string) => set({ [k]: v || undefined });
  const number = (k: 'pageSize' | 'startAt') => (v: string | number) => set({ [k]: v === '' ? undefined : Number(v) });
  const paged = p.type === 'offset' || p.type === 'page' || p.type === 'cursor';
  return (
    <Stack gap="xs">
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <Select
          label="Pagination"
          aria-label="Pagination type"
          data={[
            { value: 'none', label: 'None (one request)' },
            { value: 'link', label: 'Link header (rel=next)' },
            { value: 'next', label: 'Next URL in the body' },
            { value: 'offset', label: 'Offset' },
            { value: 'page', label: 'Page number' },
            { value: 'cursor', label: 'Cursor' },
          ].filter((o) => PAGINATION_TYPES.includes(o.value as ConnectorPagination['type']))}
          value={p.type}
          allowDeselect={false}
          onChange={(t) => onChange(!t || t === 'none' ? null : { type: t as ConnectorPagination['type'] })}
        />
        {paged && (
          <TextInput
            label="Parameter"
            withAsterisk
            description={p.type === 'cursor' ? 'Receives the cursor' : p.type === 'page' ? 'Receives the page number' : 'Receives the offset'}
            value={p.param ?? ''}
            onChange={(e) => text('param')(e.currentTarget.value)}
            styles={MONO_INPUT}
          />
        )}
        {paged && <NumberInput label="Page size" min={1} max={10000} value={p.pageSize ?? ''} onChange={number('pageSize')} />}
      </SimpleGrid>
      {p.type === 'next' && (
        <ExpressionInput
          label="Next URL"
          required
          description="JSONata giving the next URL (same origin)"
          placeholder="links.next"
          value={p.nextUrl ?? ''}
          onChange={text('nextUrl')}
        />
      )}
      {(p.type === 'offset' || p.type === 'page') && (
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <ExpressionInput
            label="Total"
            description="JSONata of the total number of items (stop condition)"
            value={p.totalPath ?? ''}
            onChange={text('totalPath')}
          />
          {p.type === 'page' && <NumberInput label="First page" description="Default 1" min={0} value={p.startAt ?? ''} onChange={number('startAt')} />}
        </SimpleGrid>
      )}
      {p.type === 'cursor' && (
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <ExpressionInput label="Cursor in the body" description="JSONata of the next cursor…" value={p.cursorPath ?? ''} onChange={text('cursorPath')} />
          <TextInput
            label="…or cursor header"
            description="Response header holding it"
            placeholder="x-ms-continuationtoken"
            value={p.cursorHeader ?? ''}
            onChange={(e) => text('cursorHeader')(e.currentTarget.value)}
            styles={MONO_INPUT}
          />
        </SimpleGrid>
      )}
      {paged && (
        <Select
          label="Send the parameter in"
          w={220}
          data={[
            { value: 'query', label: 'Query string' },
            { value: 'body', label: 'Body' },
          ]}
          value={p.in ?? 'query'}
          allowDeselect={false}
          onChange={(v) => set({ in: v === 'body' ? 'body' : undefined })}
        />
      )}
    </Stack>
  );
}

/** Key input that follows the title until edited (new items). */
function KeyInput({ value, onChange, name }: { value: string; onChange: (k: string) => void; name: string }) {
  return (
    <TextInput
      label="Key"
      aria-label={`${name} key`}
      withAsterisk
      description="Lowercase, digits, - and _"
      value={value}
      error={value && !/^[a-z][a-z0-9_-]{0,63}$/.test(value) ? 'lowercase, digits, - and _' : undefined}
      onChange={(e) => onChange(e.currentTarget.value)}
      styles={MONO_INPUT}
    />
  );
}

function titleKey<T extends { title: string; key: string; autoKey?: boolean }>(item: T, title: string): T {
  return item.autoKey ? { ...item, title, key: slugify(title) } : { ...item, title };
}

function KindCard({ k, onChange, fieldNames }: { k: KindDraft; onChange: (k: KindDraft) => void; fieldNames: string[] }) {
  const set = (patch: Partial<KindDraft>) => onChange({ ...k, ...patch });
  const name = `Kind ${k.key || 'new'}`;
  return (
    <>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput
          label="Title"
          aria-label={`${name} title`}
          placeholder="Repositories"
          value={k.title}
          onChange={(e) => onChange(titleKey(k, e.currentTarget.value))}
        />
        <KeyInput name={name} value={k.key} onChange={(key) => set({ key, autoKey: false })} />
      </SimpleGrid>
      <TextInput label="Description" value={k.description} onChange={(e) => set({ description: e.currentTarget.value })} />
      <RequestFields name={name} value={k} onChange={onChange} />
      <ExpressionInput
        label="Items"
        description="JSONata selecting the items of a response; empty: the response itself"
        placeholder="value"
        value={k.itemsPath}
        onChange={(itemsPath) => set({ itemsPath })}
      />
      <PaginationFields value={k.pagination} onChange={(pagination) => set({ pagination })} />
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput
          label="Incremental sync parameter"
          description="Query parameter receiving the time of the previous successful sync (ISO 8601); empty: full syncs"
          placeholder="updated_since"
          value={k.since}
          onChange={(e) => set({ since: e.currentTarget.value })}
          styles={MONO_INPUT}
        />
        <MultiSelect
          label="Requires"
          description="Connection fields this kind cannot work without"
          data={[...new Set([...fieldNames, ...k.requires])]}
          value={k.requires}
          onChange={(requires) => set({ requires })}
        />
      </SimpleGrid>
    </>
  );
}

function KindsTab({ doc, set }: Ctx) {
  const kinds = doc.kinds;
  const fieldNames = doc.fields.map((f) => f.name).filter(Boolean);
  return (
    <Stack gap="sm">
      <Caption>What integrations can list (ingestion): one request per kind, paginated, its items mapped to entities by the integration.</Caption>
      {!kinds.length && <Empty title="No kinds">Integrations cannot list anything from this connector.</Empty>}
      {kinds.map((k, i) => (
        <ItemCard
          key={k.id}
          heading={k.title || k.key || `Kind ${i + 1}`}
          badges={k.key && <Code>{k.key}</Code>}
          i={i}
          count={kinds.length}
          label={`kind ${k.key || i + 1}`}
          onMove={(by) => set({ kinds: move(kinds, i, by) })}
          onRemove={() => set({ kinds: kinds.filter((x) => x.id !== k.id) })}
        >
          <KindCard k={k} fieldNames={fieldNames} onChange={(next) => set({ kinds: replaceAt(kinds, i, next) })} />
        </ItemCard>
      ))}
      <AddButton label="Add a kind" onClick={() => set({ kinds: [...kinds, newKind()] })} />
    </Stack>
  );
}

// ---------- Operations ----------

const READ_ONLY = [
  { value: 'auto', label: 'Default: only GET reads' },
  { value: 'true', label: 'Reads only (allowed on read-only connections)' },
  { value: 'false', label: 'Changes things' },
];

function PollFields({ p, onChange }: { p: PollDraft; onChange: (p: PollDraft) => void }) {
  const set = (patch: Partial<PollDraft>) => onChange({ ...p, ...patch });
  return (
    <Stack gap="sm">
      <Caption>
        Repeated until <b>done</b> (or <b>failed</b>) is truthy. Expressions see <Code>connection</Code>, <Code>inputs</Code>, <Code>output</Code> (of the
        operation), <Code>status</Code> and <Code>body</Code> (the poll response).
      </Caption>
      <RequestFields name="Poll" value={p} onChange={onChange} />
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <NumberInput
          label="Interval (seconds)"
          min={2}
          max={3600}
          value={p.intervalSeconds}
          onChange={(v) => set({ intervalSeconds: v === '' ? 15 : Number(v) })}
        />
        <NumberInput
          label="Timeout (minutes)"
          min={1}
          max={10080}
          value={p.timeoutMinutes}
          onChange={(v) => set({ timeoutMinutes: v === '' ? 60 : Number(v) })}
        />
      </SimpleGrid>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <ExpressionInput label="Done" required placeholder='body.state = "completed"' value={p.done} onChange={(done) => set({ done })} />
        <ExpressionInput
          label="Failed"
          description="Checked first"
          placeholder='body.result = "failed"'
          value={p.failed}
          onChange={(failed) => set({ failed })}
        />
      </SimpleGrid>
      <Labelled label="Output when finished" description="Field → JSONata, merged over the operation's output">
        <KeyValueEditor value={p.output} onChange={(o) => set({ output: o as Record<string, string> })} keyPlaceholder="field" valuePlaceholder="body.result" />
      </Labelled>
    </Stack>
  );
}

function OperationCard({ o, onChange, kinds }: { o: OperationDraft; onChange: (o: OperationDraft) => void; kinds: string[] }) {
  const set = (patch: Partial<OperationDraft>) => onChange({ ...o, ...patch });
  const name = `Operation ${o.key || 'new'}`;
  return (
    <>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput
          label="Title"
          aria-label={`${name} title`}
          withAsterisk
          placeholder="Create an item"
          value={o.title}
          onChange={(e) => onChange(titleKey(o, e.currentTarget.value))}
        />
        <KeyInput name={name} value={o.key} onChange={(key) => set({ key, autoKey: false })} />
      </SimpleGrid>
      <Textarea label="Description" autosize minRows={1} value={o.description} onChange={(e) => set({ description: e.currentTarget.value })} />
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Select
          label="Applies to kind"
          description="Offered on the entities this kind is mapped to"
          clearable
          data={[...new Set([...kinds, o.kind].filter(Boolean))]}
          value={o.kind || null}
          onChange={(k) => set({ kind: k ?? '' })}
        />
        <Select
          label="Effect"
          data={READ_ONLY}
          value={o.readOnly === undefined ? 'auto' : String(o.readOnly)}
          allowDeselect={false}
          onChange={(v) => set({ readOnly: v === 'true' ? true : v === 'false' ? false : undefined })}
        />
      </SimpleGrid>
      <Labelled label="Inputs" description={<>The operation's form, as {'{{ inputs.<key> }}'} in templates</>}>
        <FieldsEditor fields={o.inputs} onChange={(inputs) => set({ inputs })} />
      </Labelled>
      <RequestFields name={name} value={o} onChange={onChange} />
      <Labelled label="Output" description="Field → JSONata over { connection, inputs, status, body }; empty: the response body">
        <KeyValueEditor value={o.output} onChange={(v) => set({ output: v as Record<string, string> })} keyPlaceholder="field" valuePlaceholder="body.id" />
      </Labelled>
      <Switch
        label="Poll until finished"
        description="Long-running operations: repeat a request until a condition holds"
        checked={!!o.poll}
        onChange={(e) => set({ poll: e.currentTarget.checked ? newPoll() : null })}
      />
      {o.poll && <PollFields p={o.poll} onChange={(poll) => set({ poll })} />}
    </>
  );
}

function OperationsTab({ doc, set }: Ctx) {
  const ops = doc.operations;
  const kinds = doc.kinds.map((k) => k.key).filter(Boolean);
  return (
    <Stack gap="sm">
      <Caption>What workflow steps call: one API request each, with a form, an output and optional polling.</Caption>
      {!ops.length && <Empty title="No operations">Workflows cannot call this connector.</Empty>}
      {ops.map((o, i) => (
        <ItemCard
          key={o.id}
          heading={o.title || o.key || `Operation ${i + 1}`}
          badges={
            <>
              {o.key && <Code>{o.key}</Code>}
              <Badge size="xs" variant="light" color={(o.readOnly ?? o.method === 'GET') ? 'gray' : 'orange'}>
                {(o.readOnly ?? o.method === 'GET') ? 'reads' : 'writes'}
              </Badge>
            </>
          }
          i={i}
          count={ops.length}
          label={`operation ${o.key || i + 1}`}
          onMove={(by) => set({ operations: move(ops, i, by) })}
          onRemove={() => set({ operations: ops.filter((x) => x.id !== o.id) })}
        >
          <OperationCard o={o} kinds={kinds} onChange={(next) => set({ operations: replaceAt(ops, i, next) })} />
        </ItemCard>
      ))}
      <AddButton label="Add an operation" onClick={() => set({ operations: [...ops, newOperation()] })} />
    </Stack>
  );
}

// ---------- builder ----------

export function ConnectorBuilder(props: EditorProps & { readOnlyNotice?: ReactNode }) {
  return (
    <FormBuilder<ConnectorDoc>
      {...props}
      noun="connector"
      toDoc={toConnectorDoc}
      toBody={connectorBody}
      problems={connectorProblems}
      tabs={[
        { value: 'general', label: 'General', icon: <IconWritingSign size={ICON.md} />, render: (ctx) => <GeneralTab {...ctx} /> },
        {
          value: 'fields',
          label: 'Connection form',
          icon: <IconForms size={ICON.md} />,
          count: (d) => d.fields.length,
          render: (ctx) => <FieldsTab {...ctx} />,
        },
        { value: 'auth', label: 'Authentication', icon: <IconKey size={ICON.md} />, count: (d) => d.auth.length, render: (ctx) => <AuthTab {...ctx} /> },
        { value: 'headers', label: 'Headers and test', icon: <IconHeartbeat size={ICON.md} />, render: (ctx) => <HeadersTab {...ctx} /> },
        { value: 'kinds', label: 'Kinds', icon: <IconListDetails size={ICON.md} />, count: (d) => d.kinds.length, render: (ctx) => <KindsTab {...ctx} /> },
        {
          value: 'operations',
          label: 'Operations',
          icon: <IconBolt size={ICON.md} />,
          count: (d) => d.operations.length,
          render: (ctx) => <OperationsTab {...ctx} />,
        },
      ]}
    />
  );
}
