import { useState, type ReactNode } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Button,
  Card,
  Group,
  Input,
  Modal,
  NumberInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  TagsInput,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconArrowLeft, IconCoin, IconCopy, IconFlask, IconLeaf, IconPlus, IconReceipt, IconSearch, IconTrash } from '@tabler/icons-react';
import type { PlanCheckOutput } from '@asterius/shared';
import { api, errorText, request } from '../../lib/api';
import { CodeEditor } from '../CodeEditor';
import { DataTable } from '../DataTable';
import { PlanCheckSummary } from '../PlanCheckSummary';
import { Mono } from '../ui';
import { MONO_INPUT } from './blocks';
import { FormBuilder, IdentityFields, type EditorProps, type FormContext } from './FormBuilder';
import {
  copyEntry,
  entryLabel,
  extendersOf,
  matchSummary,
  newEntry,
  newMatch,
  newNumRow,
  newUnit,
  priceCatalogBody,
  priceCatalogProblems,
  priceSummary,
  toPriceCatalogDoc,
  type EntryRow,
  type MatchKind,
  type MatchRow,
  type NumRow,
  type PriceCatalogDoc,
  type PricingMode,
  type UnitRow,
} from './priceCatalog';

/**
 * Form editor of price catalogs (plan-check steps: cost and carbon estimates of a Terraform / OpenTofu plan), with
 * the JSON / YAML views of FormBuilder. The model and its validation are in priceCatalog.ts.
 */

/** The estimate endpoint: a saved catalog (and the plan policies) on a plan, without a run. */
export const priceCatalogApi = {
  estimate: (id: string, plan: unknown) => request<PlanCheckOutput>('POST', `/api/v1/price-catalogs/${encodeURIComponent(id)}/estimate`, { plan }),
};

const PAGE = 50;
const MODES: { value: PricingMode; label: string }[] = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'hourly', label: 'Hourly' },
  { value: 'perUnit', label: 'Per unit' },
  { value: 'free', label: 'Free' },
  { value: 'usageBased', label: 'Usage-based' },
];
const MATCH_KINDS: { value: MatchKind; label: string }[] = [
  { value: 'text', label: 'Text (* wildcard)' },
  { value: 'list', label: 'One of' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
];

/** NumberInput value / onChange of an optional number ('' clears it). */
const numeric = (value: number | undefined, onChange: (n: number | undefined) => void) => ({
  value: value ?? '',
  onChange: (x: number | string) => onChange(x === '' ? undefined : Number(x)),
});

/** A link-like control that keeps working in read-only dialogs (the disabled fieldset disables buttons). */
function NavLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Anchor
      href="#"
      fz="sm"
      onClick={(e) => {
        e.preventDefault();
        onClick();
      }}
    >
      <Group gap="4xs" wrap="nowrap">
        {children}
      </Group>
    </Anchor>
  );
}

export function PriceCatalogBuilder(props: EditorProps) {
  const catalogs = useQuery({ queryKey: ['price-catalogs', 'refs'], queryFn: api.priceCatalogs, staleTime: 30_000 });
  const refs = (catalogs.data ?? []).map((c) => ({ identifier: c.identifier, currency: c.currency, extends: c.extends }));
  const [trying, setTrying] = useState(false);
  const id = String(props.value?.identifier ?? '');
  const builtin = !!props.readOnly && id === 'builtin';
  return (
    <>
      <FormBuilder<PriceCatalogDoc>
        {...props}
        size="76rem"
        noun="price catalog"
        toDoc={toPriceCatalogDoc}
        toBody={priceCatalogBody}
        problems={(d) => priceCatalogProblems(d, refs)}
        header={
          (builtin || !props.isNew) && (
            <Group justify="space-between" wrap="nowrap" align="flex-start">
              <Text fz="sm" c="dimmed">
                {builtin
                  ? 'The built-in sample (approximate list prices): copy entries from the JSON / YAML views, or create a catalog that extends builtin.'
                  : ''}
              </Text>
              {!props.isNew && (
                <Button size="xs" variant="light" leftSection={<IconFlask size={14} />} onClick={() => setTrying(true)}>
                  Try on a plan
                </Button>
              )}
            </Group>
          )
        }
        tabs={[
          { value: 'catalog', label: 'Catalog', icon: <IconReceipt size={16} />, render: (ctx) => <CatalogTab ctx={ctx} refs={refs} /> },
          { value: 'prices', label: 'Prices', icon: <IconCoin size={16} />, count: (d) => d.prices.length, render: (ctx) => <PricesTab ctx={ctx} /> },
          { value: 'carbon', label: 'Carbon', icon: <IconLeaf size={16} />, render: (ctx) => <CarbonTab ctx={ctx} /> },
        ]}
      />
      {trying && props.value && <TryPlanModal id={id} onClose={() => setTrying(false)} />}
    </>
  );
}

// ---------- catalog ----------

function CatalogTab({ ctx, refs }: { ctx: FormContext<PriceCatalogDoc>; refs: { identifier: string; currency: string; extends?: string }[] }) {
  const { doc, set } = ctx;
  const loops = extendersOf(doc.identifier, refs);
  const parents = refs
    .filter((c) => c.identifier !== doc.identifier && !loops.has(c.identifier))
    .map((c) => ({ value: c.identifier, label: `${c.identifier} (${c.currency})` }));
  if (doc.extends && !parents.some((p) => p.value === doc.extends)) parents.push({ value: doc.extends, label: doc.extends });
  return (
    <Stack gap="md">
      <IdentityFields {...ctx} placeholder="Negotiated prices" />
      <Textarea label="Description" autosize minRows={2} value={doc.description} onChange={(e) => set({ description: e.currentTarget.value })} />
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <TextInput
          label="Currency"
          withAsterisk
          description="ISO 4217 code (EUR, USD)"
          maxLength={3}
          value={doc.currency}
          onChange={(e) => set({ currency: e.currentTarget.value.toUpperCase() })}
          error={doc.currency && !/^[A-Z]{3}$/.test(doc.currency) ? '3 capital letters' : undefined}
          styles={MONO_INPUT}
        />
        <Select
          label="Extends"
          description="Prices what this catalog does not (same currency)"
          placeholder="Nothing"
          clearable
          searchable
          data={parents}
          value={doc.extends}
          onChange={(v) => set({ extends: v })}
        />
        <NumberInput
          label="Hours per month"
          description="Turns hourly prices into monthly ones (730 on average)"
          min={1}
          max={744}
          {...numeric(doc.hoursPerMonth, (hoursPerMonth) => set({ hoursPerMonth }))}
        />
      </SimpleGrid>
      <TagsInput
        label="Free providers"
        description="Providers whose resources are never billed (random, null, tls…): neither priced nor reported as unmatched"
        placeholder="Type and press Enter"
        value={doc.freeProviders}
        onChange={(freeProviders) => set({ freeProviders })}
      />
    </Stack>
  );
}

// ---------- prices ----------

function PricesTab({ ctx }: { ctx: FormContext<PriceCatalogDoc> }) {
  const { doc, set, readOnly } = ctx;
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const put = (prices: EntryRow[]) => set({ prices });
  const index = doc.prices.findIndex((e) => e.id === selected);

  if (index >= 0) {
    const entry = doc.prices[index]!;
    return (
      <EntryEditor
        entry={entry}
        index={index}
        total={doc.prices.length}
        currency={doc.currency || 'USD'}
        hoursPerMonth={doc.hoursPerMonth ?? 730}
        readOnly={readOnly}
        onBack={() => setSelected(null)}
        onChange={(patch) => put(doc.prices.map((e) => (e.id === entry.id ? { ...e, ...patch } : e)))}
      />
    );
  }

  const q = filter.trim().toLowerCase();
  const rows = doc.prices.map((e, i) => ({ e, i })).filter(({ e }) => !q || `${e.provider} ${e.type} ${matchSummary(e)}`.toLowerCase().includes(q));
  // Paging uses buttons, which a read-only dialog disables: read-only lists show everything.
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const current = Math.min(page, pages);
  const shown = readOnly ? rows : rows.slice((current - 1) * PAGE, current * PAGE);
  const add = () => {
    const e = newEntry();
    put([...doc.prices, e]);
    setSelected(e.id);
  };
  return (
    <Stack gap="sm">
      <Text fz="sm" c="dimmed">
        A resource takes the price of the most specific matching entry (most matchers) of this catalog, then of the catalogs it extends. Resources without a
        price are reported as unmatched, never silently ignored.
      </Text>
      <Group justify="space-between">
        <TextInput
          aria-label="Filter prices"
          placeholder="Filter on provider, type or matcher"
          leftSection={<IconSearch size={14} />}
          value={filter}
          onChange={(e) => {
            setFilter(e.currentTarget.value);
            setPage(1);
          }}
          w={320}
        />
        {!readOnly && (
          <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={add}>
            Add price
          </Button>
        )}
      </Group>
      <DataTable
        rows={shown}
        rowKey={(r) => r.e.id}
        onRowClick={(r) => setSelected(r.e.id)}
        empty={q ? 'No price matches the filter' : 'No price yet: add one, or extend a catalog for what this one does not price'}
        page={readOnly ? undefined : { page: current, pageSize: PAGE, total: rows.length, onChange: setPage }}
        columns={[
          { key: 'n', label: '#', width: 48, render: (r) => r.i + 1 },
          { key: 'p', label: 'Provider', render: (r) => <Mono>{r.e.provider || '—'}</Mono> },
          { key: 't', label: 'Resource type', truncate: true, render: (r) => <Mono>{r.e.type || '—'}</Mono> },
          { key: 'm', label: 'Matchers', truncate: true, render: (r) => matchSummary(r.e) },
          { key: 'x', label: 'Price', truncate: true, render: (r) => priceSummary(r.e, doc.currency) },
          ...(readOnly
            ? []
            : [
                {
                  key: 'a',
                  label: '',
                  width: 80,
                  render: (r: { e: EntryRow; i: number }) => (
                    <Group gap="4xs" wrap="nowrap" justify="flex-end" onClick={(ev) => ev.stopPropagation()}>
                      <Tooltip label="Duplicate">
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          aria-label={`Duplicate ${entryLabel(r.e, r.i)}`}
                          onClick={() => put([...doc.prices.slice(0, r.i + 1), copyEntry(r.e), ...doc.prices.slice(r.i + 1)])}
                        >
                          <IconCopy size={16} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Remove">
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          aria-label={`Remove ${entryLabel(r.e, r.i)}`}
                          onClick={() => put(doc.prices.filter((x) => x.id !== r.e.id))}
                        >
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  ),
                },
              ]),
        ]}
      />
    </Stack>
  );
}

function EntryEditor(props: {
  entry: EntryRow;
  index: number;
  total: number;
  currency: string;
  hoursPerMonth: number;
  readOnly?: boolean;
  onBack: () => void;
  onChange: (patch: Partial<EntryRow>) => void;
}) {
  const { entry: e, onChange, currency } = props;
  const priced = e.mode === 'monthly' || e.mode === 'hourly' || e.mode === 'perUnit';
  return (
    <Stack gap="md">
      <Group justify="space-between">
        <NavLink onClick={props.onBack}>
          <IconArrowLeft size={14} /> All prices
        </NavLink>
        <Text fz="sm" c="dimmed">
          Price {props.index + 1} of {props.total}
        </Text>
      </Group>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput
          label="Provider"
          withAsterisk
          description="Short name: azurerm, aws, google; * for any"
          placeholder="azurerm"
          value={e.provider}
          onChange={(ev) => onChange({ provider: ev.currentTarget.value })}
          styles={MONO_INPUT}
        />
        <TextInput
          label="Resource type"
          withAsterisk
          description="Terraform type; * wildcards (aws_iam_*)"
          placeholder="azurerm_linux_virtual_machine"
          value={e.type}
          onChange={(ev) => onChange({ type: ev.currentTarget.value })}
          styles={MONO_INPUT}
        />
      </SimpleGrid>
      <Input.Wrapper
        label="Matchers"
        description="Attribute path in the planned values (size, default_node_pool.0.vm_size) → expected value; region is the resource's region. No matcher: every resource of the type."
      >
        <MatchersEditor rows={e.match} onChange={(match) => onChange({ match })} readOnly={props.readOnly} />
      </Input.Wrapper>
      <div>
        <Text fz="sm" fw={500} mb="3xs">
          Pricing
        </Text>
        <SegmentedControl aria-label="Pricing mode" value={e.mode} onChange={(m) => onChange({ mode: m as PricingMode })} data={MODES} />
        <Text fz="xs" c="dimmed" mt="3xs">
          {e.mode === 'free' && 'Not billed by itself (networking glue, IAM, a web app billed through its plan).'}
          {e.mode === 'usageBased' && 'Billed on usage the plan does not show (storage, requests): counted as 0 and listed as usage-based.'}
          {e.mode === 'perUnit' && 'Units read from an attribute (disk size, capacity) times a unit price, plus optional base prices.'}
          {e.mode === 'hourly' && `Hourly price × ${props.hoursPerMonth} hours per month.`}
          {e.mode === 'monthly' && 'A fixed monthly price.'}
        </Text>
      </div>
      {e.mode === 'monthly' && (
        <NumberInput label={`Monthly price (${currency})`} withAsterisk min={0} w={260} {...numeric(e.monthly, (monthly) => onChange({ monthly }))} />
      )}
      {(e.mode === 'hourly' || e.mode === 'perUnit') && (
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <NumberInput
            label={`${e.mode === 'perUnit' ? 'Base hourly price' : 'Hourly price'} (${currency})`}
            withAsterisk={e.mode === 'hourly'}
            min={0}
            {...numeric(e.hourly, (hourly) => onChange({ hourly }))}
          />
          <NumberInput
            label={`Monthly fee (${currency})`}
            description="Optional, added to the price"
            min={0}
            {...numeric(e.monthly, (monthly) => onChange({ monthly }))}
          />
        </SimpleGrid>
      )}
      {e.mode === 'perUnit' && <UnitsEditor units={e.perUnit} currency={currency} onChange={(perUnit) => onChange({ perUnit })} readOnly={props.readOnly} />}
      {priced && (
        <Stack gap="xs">
          <Switch
            label="Multiply by an attribute (node count, instances)"
            checked={!!e.quantity}
            onChange={(ev) => onChange({ quantity: ev.currentTarget.checked ? { attribute: '', default: 1 } : null })}
          />
          {e.quantity && (
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput
                label="Quantity attribute"
                withAsterisk
                placeholder="default_node_pool.0.node_count"
                value={e.quantity.attribute}
                onChange={(ev) => onChange({ quantity: { ...e.quantity!, attribute: ev.currentTarget.value } })}
                styles={MONO_INPUT}
              />
              <NumberInput
                label="Default quantity"
                description="When the attribute is unknown until apply"
                min={0}
                {...numeric(e.quantity.default, (d) => onChange({ quantity: { ...e.quantity!, default: d } }))}
              />
            </SimpleGrid>
          )}
        </Stack>
      )}
      {e.mode !== 'free' && (
        <Input.Wrapper label="Power draw (carbon)" description="Average watts, or vCPUs and memory converted with the catalog's carbon coefficients">
          <SimpleGrid cols={{ base: 1, sm: 3 }} mt="3xs">
            <NumberInput label="Watts" min={0} {...numeric(e.watts, (watts) => onChange({ watts }))} />
            <NumberInput label="vCPUs" min={0} {...numeric(e.vcpu, (vcpu) => onChange({ vcpu }))} />
            <NumberInput label="Memory (GB)" min={0} {...numeric(e.memoryGb, (memoryGb) => onChange({ memoryGb }))} />
          </SimpleGrid>
        </Input.Wrapper>
      )}
      <TextInput
        label="Note"
        description="Shown with the estimate (savings plan, licence not included…)"
        maxLength={300}
        value={e.note}
        onChange={(ev) => onChange({ note: ev.currentTarget.value })}
      />
    </Stack>
  );
}

function MatchersEditor({ rows, onChange, readOnly }: { rows: MatchRow[]; onChange: (rows: MatchRow[]) => void; readOnly?: boolean }) {
  const edit = (id: string, patch: Partial<MatchRow>) => onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  return (
    <Stack gap="2xs" mt="3xs">
      {rows.map((r, i) => (
        <Group key={r.id} gap="2xs" wrap="nowrap" align="flex-start">
          <TextInput
            aria-label={`Matcher ${i + 1} attribute`}
            placeholder="size"
            w="32%"
            value={r.key}
            onChange={(e) => edit(r.id, { key: e.currentTarget.value })}
            styles={MONO_INPUT}
          />
          <Select
            aria-label={`Matcher ${i + 1} kind`}
            w={170}
            allowDeselect={false}
            data={MATCH_KINDS}
            value={r.kind}
            onChange={(k) => {
              const kind = (k ?? 'text') as MatchKind;
              // Carry the value over: text ↔ list, and a sensible boolean.
              if (kind === 'list') edit(r.id, { kind, list: r.list.length ? r.list : r.text.trim() ? [r.text.trim()] : [] });
              else if (kind === 'boolean') edit(r.id, { kind, text: r.text === 'false' ? 'false' : 'true' });
              else edit(r.id, { kind, text: r.kind === 'list' ? (r.list[0] ?? '') : r.text });
            }}
          />
          {r.kind === 'list' ? (
            <TagsInput
              aria-label={`Matcher ${i + 1} values`}
              flex={1}
              placeholder="Type and press Enter"
              value={r.list}
              onChange={(list) => edit(r.id, { list })}
            />
          ) : r.kind === 'boolean' ? (
            <Select
              aria-label={`Matcher ${i + 1} value`}
              flex={1}
              allowDeselect={false}
              data={['true', 'false']}
              value={r.text}
              onChange={(v) => edit(r.id, { text: v ?? 'true' })}
            />
          ) : (
            <TextInput
              aria-label={`Matcher ${i + 1} value`}
              flex={1}
              placeholder={r.kind === 'number' ? '3' : 'Standard_D2s_v5, t3.*'}
              value={r.text}
              onChange={(e) => edit(r.id, { text: e.currentTarget.value })}
              error={r.kind === 'number' && r.text.trim() && !Number.isFinite(Number(r.text)) ? 'not a number' : undefined}
              styles={MONO_INPUT}
            />
          )}
          {!readOnly && (
            <ActionIcon
              variant="subtle"
              color="gray"
              size="lg"
              aria-label={`Remove matcher ${i + 1}`}
              onClick={() => onChange(rows.filter((x) => x.id !== r.id))}
            >
              <IconTrash size={16} />
            </ActionIcon>
          )}
        </Group>
      ))}
      {!readOnly && (
        <Group>
          <Button variant="subtle" color="gray" size="xs" leftSection={<IconPlus size={14} />} onClick={() => onChange([...rows, newMatch()])}>
            Add matcher
          </Button>
        </Group>
      )}
    </Stack>
  );
}

function UnitsEditor({ units, currency, onChange, readOnly }: { units: UnitRow[]; currency: string; onChange: (u: UnitRow[]) => void; readOnly?: boolean }) {
  const edit = (id: string, patch: Partial<UnitRow>) => onChange(units.map((u) => (u.id === id ? { ...u, ...patch } : u)));
  return (
    <Stack gap="xs">
      {units.map((u, i) => (
        <Card key={u.id} withBorder p="sm">
          <Stack gap="xs">
            <Group wrap="nowrap" align="flex-end">
              <TextInput
                flex={1}
                label={`Unit ${i + 1} attribute`}
                withAsterisk
                placeholder="disk_size_gb"
                value={u.attribute}
                onChange={(e) => edit(u.id, { attribute: e.currentTarget.value })}
                styles={MONO_INPUT}
              />
              {!readOnly && (
                <ActionIcon
                  variant="subtle"
                  color="red"
                  size="lg"
                  aria-label={`Remove unit ${i + 1}`}
                  onClick={() => onChange(units.filter((x) => x.id !== u.id))}
                >
                  <IconTrash size={16} />
                </ActionIcon>
              )}
            </Group>
            <SimpleGrid cols={{ base: 2, sm: 5 }}>
              <NumberInput label="Scale" description="e.g. 1/1024 for MB → GB" min={0} {...numeric(u.scale, (scale) => edit(u.id, { scale }))} />
              <NumberInput label="Default units" description="When unknown" min={0} {...numeric(u.default, (d) => edit(u.id, { default: d }))} />
              <NumberInput label={`Monthly per unit (${currency})`} min={0} {...numeric(u.monthly, (monthly) => edit(u.id, { monthly }))} />
              <NumberInput label={`Hourly per unit (${currency})`} min={0} {...numeric(u.hourly, (hourly) => edit(u.id, { hourly }))} />
              <NumberInput label="Watts per unit" min={0} {...numeric(u.watts, (watts) => edit(u.id, { watts }))} />
            </SimpleGrid>
          </Stack>
        </Card>
      ))}
      {!readOnly && (
        <Group>
          <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} disabled={units.length >= 10} onClick={() => onChange([...units, newUnit()])}>
            Add unit
          </Button>
        </Group>
      )}
    </Stack>
  );
}

// ---------- carbon ----------

function NumberTable(props: {
  label: string;
  description: string;
  keyLabel: string;
  keyPlaceholder: string;
  rows: NumRow[];
  onChange: (rows: NumRow[]) => void;
  min: number;
  max?: number;
  readOnly?: boolean;
}) {
  const { rows, onChange } = props;
  const edit = (id: string, patch: Partial<NumRow>) => onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  return (
    <Input.Wrapper label={props.label} description={props.description}>
      <Stack gap="2xs" mt="3xs">
        {rows.map((r, i) => (
          <Group key={r.id} gap="2xs" wrap="nowrap" align="flex-start">
            <TextInput
              aria-label={`${props.label} ${props.keyLabel} ${i + 1}`}
              placeholder={props.keyPlaceholder}
              flex={1}
              value={r.key}
              onChange={(e) => edit(r.id, { key: e.currentTarget.value })}
              styles={MONO_INPUT}
            />
            <NumberInput
              aria-label={`${props.label} value ${i + 1}`}
              w={160}
              min={props.min}
              max={props.max}
              {...numeric(r.value, (value) => edit(r.id, { value }))}
            />
            {!props.readOnly && (
              <ActionIcon
                variant="subtle"
                color="gray"
                size="lg"
                aria-label={`Remove ${props.label} ${i + 1}`}
                onClick={() => onChange(rows.filter((x) => x.id !== r.id))}
              >
                <IconTrash size={16} />
              </ActionIcon>
            )}
          </Group>
        ))}
        {!props.readOnly && (
          <Group>
            <Button variant="subtle" color="gray" size="xs" leftSection={<IconPlus size={14} />} onClick={() => onChange([...rows, newNumRow()])}>
              Add
            </Button>
          </Group>
        )}
      </Stack>
    </Input.Wrapper>
  );
}

function CarbonTab({ ctx }: { ctx: FormContext<PriceCatalogDoc> }) {
  const { doc, set, readOnly } = ctx;
  return (
    <Stack gap="lg">
      <Text fz="sm" c="dimmed">
        Carbon estimate (Cloud Carbon Footprint method): average watts × hours × PUE of the provider × grid emission factor of the region. What is left empty
        here comes from the catalogs this one extends, then from defaults (PUE 1.2, 0.475 kgCO2e/kWh, 2.2 W per vCPU, 0.392 W per GB).
      </Text>
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xl">
        <NumberTable
          label="PUE"
          description="Power usage effectiveness per provider, 1 to 3"
          keyLabel="provider"
          keyPlaceholder="azurerm"
          min={1}
          max={3}
          rows={doc.pue}
          onChange={(pue) => set({ pue })}
          readOnly={readOnly}
        />
        <NumberTable
          label="Watts per vCPU"
          description="Average watts per vCPU, per provider"
          keyLabel="provider"
          keyPlaceholder="aws"
          min={0}
          rows={doc.wattsPerVcpu}
          onChange={(wattsPerVcpu) => set({ wattsPerVcpu })}
          readOnly={readOnly}
        />
        <NumberTable
          label="Grid intensity"
          description="Grid emission factor per region, kgCO2e per kWh (0 to 2)"
          keyLabel="region"
          keyPlaceholder="westeurope"
          min={0}
          max={2}
          rows={doc.gridIntensity}
          onChange={(gridIntensity) => set({ gridIntensity })}
          readOnly={readOnly}
        />
        <Stack gap="md">
          <NumberInput
            label="Default grid intensity"
            description="kgCO2e per kWh, for regions not listed"
            min={0}
            max={2}
            {...numeric(doc.defaultGridIntensity, (defaultGridIntensity) => set({ defaultGridIntensity }))}
          />
          <NumberInput label="Watts per GB of memory" min={0} {...numeric(doc.wattsPerGbMemory, (wattsPerGbMemory) => set({ wattsPerGbMemory }))} />
        </Stack>
      </SimpleGrid>
    </Stack>
  );
}

// ---------- try ----------

function TryPlanModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<PlanCheckOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const run = async () => {
    setError(null);
    setResult(null);
    let plan: unknown;
    try {
      plan = JSON.parse(text);
    } catch {
      return setError('The plan must be JSON (terraform show -json plan.out)');
    }
    setRunning(true);
    try {
      setResult(await priceCatalogApi.estimate(id, plan));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setRunning(false);
    }
  };
  return (
    <Modal opened onClose={onClose} size="xl" title={<Text fw={600}>Try {id} on a plan</Text>}>
      <Stack gap="sm">
        <Text fz="sm" c="dimmed">
          Paste the output of <Mono>terraform show -json plan.out</Mono> (or tofu). The saved version of the catalog is used, with the organization's plan
          policies: save your changes first.
        </Text>
        <CodeEditor language="json" aria-label="Plan JSON" minRows={8} maxRows={16} value={text} onChange={setText} />
        <Group justify="flex-end">
          <Button onClick={() => void run()} loading={running} disabled={!text.trim()} leftSection={<IconFlask size={16} />}>
            Estimate
          </Button>
        </Group>
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}
        {result && <PlanCheckSummary output={result} />}
      </Stack>
    </Modal>
  );
}
