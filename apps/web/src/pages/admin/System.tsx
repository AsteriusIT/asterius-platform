import { useState } from 'react';
import { Alert, Badge, Button, Card, Code, FileButton, Group, Modal, Select, SimpleGrid, Stack, Text, TextInput } from '@mantine/core';
import { modals } from '@mantine/modals';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconArrowBackUp, IconDownload, IconRefresh, IconSearch, IconTrash, IconUpload } from '@tabler/icons-react';
import { api, errorText } from '../../lib/api';
import { downloadText } from '../../lib/catalogView';
import { auditToCsv } from '../../lib/auditCsv';
import { notifyError, useAppMutation } from '../../lib/queryClient';
import { DataTable } from '../../components/DataTable';
import { InlineCode } from '../../components/CodeEditor';
import { Mono, PageHeader, QueryView, TimeAgo } from '../../components/ui';

const PAGE = 50;

export function AuditAdmin() {
  const [search, setSearch] = useState('');
  const [debounced] = useDebouncedValue(search, 300);
  const [actor, setActor] = useState<string | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const [target, setTarget] = useState('');
  const [debouncedTarget] = useDebouncedValue(target, 300);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const facets = useQuery({ queryKey: ['audit-facets'], queryFn: api.auditFacets, staleTime: 60_000 });
  // `to` is a date: include the whole day.
  const filters = {
    search: debounced,
    actor: actor ?? undefined,
    action: action ?? undefined,
    target: debouncedTarget,
    from: from || undefined,
    to: to ? `${to}T23:59:59.999Z` : undefined,
  };
  const q = useQuery({
    queryKey: ['audit', filters, page],
    queryFn: () => api.audit({ ...filters, limit: PAGE + 1, offset: (page - 1) * PAGE }),
    placeholderData: keepPreviousData,
  });
  const rows = q.data?.slice(0, PAGE);
  const reset =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setPage(1);
    };
  const exportCsv = async () => {
    try {
      const all = await api.audit({ ...filters, limit: 5000, offset: 0 });
      downloadText('audit-log.csv', auditToCsv(all));
    } catch (e) {
      notifyError(e, 'Export failed');
    }
  };
  return (
    <Stack>
      <PageHeader
        title="Audit log"
        description="Who changed what: definitions, catalog writes, runs, approvals, tokens, secrets, sign-ins."
        refresh={q}
        actions={
          <Button variant="default" leftSection={<IconDownload size={16} />} onClick={() => void exportCsv()}>
            Export CSV
          </Button>
        }
      />
      <Group align="flex-end">
        <TextInput
          label="Search"
          placeholder="Action, target or user"
          leftSection={<IconSearch size={16} />}
          value={search}
          onChange={(e) => reset(setSearch)(e.currentTarget.value)}
          w={240}
        />
        <Select label="Actor" placeholder="Anyone" searchable clearable data={facets.data?.actors ?? []} value={actor} onChange={reset(setActor)} w={220} />
        <Select label="Action" placeholder="Any" searchable clearable data={facets.data?.actions ?? []} value={action} onChange={reset(setAction)} w={200} />
        <TextInput label="Resource" placeholder="Target contains" value={target} onChange={(e) => reset(setTarget)(e.currentTarget.value)} w={180} />
        <TextInput label="From" type="date" value={from} onChange={(e) => reset(setFrom)(e.currentTarget.value)} />
        <TextInput label="To" type="date" value={to} onChange={(e) => reset(setTo)(e.currentTarget.value)} />
      </Group>
      <DataTable
        rows={rows}
        loading={q.isPending}
        error={q.error}
        rowKey={(a) => a.id}
        empty="No audit entry matches"
        columns={[
          { key: 'w', label: 'When', render: (a) => <TimeAgo at={a.at} /> },
          { key: 'u', label: 'Who', render: (a) => <Text fz="sm">{a.actorEmail ?? 'system'}</Text> },
          { key: 'a', label: 'Action', render: (a) => <Mono>{a.action}</Mono> },
          {
            key: 't',
            label: 'Target',
            render: (a) => (
              <Text fz="sm" style={{ overflowWrap: 'anywhere' }}>
                {a.target ?? '—'}
              </Text>
            ),
          },
          { key: 'd', label: 'Detail', render: (a) => (Object.keys(a.detail).length ? <InlineCode code={JSON.stringify(a.detail)} /> : '') },
        ]}
      />
      <Group justify="flex-end">
        <Button variant="default" size="xs" disabled={page === 1} onClick={() => setPage(page - 1)}>
          Newer
        </Button>
        <Button variant="default" size="xs" disabled={(q.data?.length ?? 0) <= PAGE} onClick={() => setPage(page + 1)}>
          Older
        </Button>
      </Group>
    </Stack>
  );
}

export function ConfigAdmin() {
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ['config-info'], queryFn: api.configInfo });
  const status = useQuery({ queryKey: ['config-status'], queryFn: api.configStatus, refetchInterval: 30_000 });
  const plan = useQuery({ queryKey: ['config-plan'], queryFn: api.configPlan });
  const [busy, setBusy] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);

  const download = async () => {
    const yaml = await api.configExport();
    const url = URL.createObjectURL(new Blob([yaml], { type: 'text/yaml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `asterius-config-${new Date().toISOString().slice(0, 10)}.yaml`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const diff = useQuery({ queryKey: ['config-diff'], queryFn: api.configDiff, enabled: diffOpen });
  const importFile = async (file: File | null) => {
    if (!file) return;
    try {
      const yaml = await file.text();
      const check = await api.configImport(yaml, true);
      modals.openConfirmModal({
        title: `Import ${file.name}?`,
        children: (
          <Text fz="sm">
            Creates or updates{' '}
            {Object.entries(check.counts)
              .map(([k, n]) => `${n} ${k}`)
              .join(', ')}{' '}
            as regular (editable) resources.
          </Text>
        ),
        labels: { confirm: 'Import', cancel: 'Cancel' },
        onConfirm: () =>
          void api.configImport(yaml, false).then(
            () => {
              notifications.show({ color: 'green', message: 'Imported' });
              void qc.invalidateQueries();
            },
            (e) => notifyError(e, 'Import failed'),
          ),
      });
    } catch (e) {
      notifyError(e, 'Invalid file');
    }
  };
  const reload = async () => {
    setDiffOpen(false);
    setBusy(true);
    try {
      await api.configReload();
      notifications.show({ color: 'green', message: 'Configuration reloaded' });
      void qc.invalidateQueries();
    } catch (e) {
      notifications.show({ color: 'red', message: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack>
      <PageHeader
        title="Configuration as code"
        description="Resources declared in the configuration directory are managed: read-only here, updated when the files change (checked every minute)."
        actions={
          <>
            <FileButton onChange={(f) => void importFile(f)} accept=".yaml,.yml,.json">
              {(props) => (
                <Button variant="default" leftSection={<IconUpload size={16} />} {...props}>
                  Import YAML
                </Button>
              )}
            </FileButton>
            <Button variant="default" leftSection={<IconRefresh size={16} />} loading={busy} onClick={() => setDiffOpen(true)}>
              Reload now
            </Button>
            <Button leftSection={<IconDownload size={16} />} onClick={() => void download()}>
              Export YAML
            </Button>
          </>
        }
      />
      <QueryView q={status}>
        {(st) => (
          <>
            {st.readError && (
              <Alert color="red" title="Configuration files cannot be read (the previous configuration stays in force)">
                {st.readError}
              </Alert>
            )}
            {st.errors.length > 0 && (
              <Alert color="orange" title={`${st.errors.length} resource(s) could not be applied`}>
                {st.errors.slice(0, 10).map((e) => (
                  <Text key={e} fz="sm">
                    {e}
                  </Text>
                ))}
              </Alert>
            )}
            <Group gap="xs">
              <Badge color={st.inSync ? 'green' : 'orange'}>{st.inSync ? 'in sync' : 'not in sync'}</Badge>
              {st.appliedAt && (
                <Text fz="sm" c="dimmed">
                  last applied <TimeAgo at={st.appliedAt} />
                </Text>
              )}
              {plan.data && (
                <Text fz="sm" c="dimmed">
                  plan: {plan.data.filter((p) => p.action === 'create').length} to create, {plan.data.filter((p) => p.action === 'update').length} to update,{' '}
                  {plan.data.filter((p) => p.action === 'delete').length} to delete
                </Text>
              )}
            </Group>
          </>
        )}
      </QueryView>
      <QueryView q={info}>
        {(i) => (
          <>
            <Text fz="sm" data-testid="config-source">
              {i.source?.type === 'git' ? (
                <>
                  Git: <Code>{i.source.url}</Code> (ref <Code>{i.source.branch}</Code>
                  {i.source.path ? (
                    <>
                      , path <Code>{i.source.path}</Code>
                    </>
                  ) : null}
                  )
                </>
              ) : i.dir ? (
                <>
                  Directory: <Code>{i.dir}</Code>
                </>
              ) : (
                <>
                  Source: <Code>none</Code> (this organization has no configuration source)
                </>
              )}
            </Text>
            <Card>
              <Group gap="xl">
                <div>
                  <Text fz="xs" c="dimmed">
                    Last applied
                  </Text>
                  <Text fz="sm">
                    <TimeAgo at={i.status.lastAppliedAt} />
                  </Text>
                </div>
                <div>
                  <Text fz="xs" c="dimmed">
                    Last checked
                  </Text>
                  <Text fz="sm">
                    <TimeAgo at={i.status.lastCheckedAt} />
                  </Text>
                </div>
                <div>
                  <Text fz="xs" c="dimmed">
                    Files
                  </Text>
                  <Text fz="sm">{i.status.files}</Text>
                </div>
              </Group>
              {i.status.error && (
                <Alert color="red" mt="sm" title="The last check failed (the previous configuration is kept)">
                  {i.status.error}
                </Alert>
              )}
            </Card>
            <SimpleGrid cols={{ base: 2, sm: 5 }}>
              {Object.entries(i.managed).map(([k, n]) => (
                <Card key={k} padding="md">
                  <Text fz={24} fw={700}>
                    {n}
                  </Text>
                  <Text fz="sm" c="dimmed">
                    managed {k}
                  </Text>
                </Card>
              ))}
            </SimpleGrid>
          </>
        )}
      </QueryView>
      <Modal opened={diffOpen} onClose={() => setDiffOpen(false)} title="Changes a reload would apply" size="lg">
        <QueryView q={diff}>
          {(d) =>
            d.error ? (
              <Alert color="red" title="Configuration files are invalid">
                {d.error}
              </Alert>
            ) : (
              <Stack gap="xs">
                {Object.entries(d.kinds).map(([k, v]) => (
                  <Text key={k} fz="sm">
                    <b>{k}</b>: {v.added.length} added{v.added.length ? ` (${v.added.join(', ')})` : ''}, {v.removed.length} removed
                    {v.removed.length ? ` (${v.removed.join(', ')})` : ''}, {v.kept.length} re-applied
                  </Text>
                ))}
                <Group justify="flex-end" mt="sm">
                  <Button variant="default" onClick={() => setDiffOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={() => void reload()}>Reload</Button>
                </Group>
              </Stack>
            )
          }
        </QueryView>
      </Modal>
      <Card>
        <Text fw={600} mb="xs">
          Moving UI changes to Git
        </Text>
        <Text fz="sm" c="dimmed">
          Export the YAML, keep the resources you want in the configuration repository and deploy it (ConfigMap / git-sync). On the next reload they become
          managed. Secrets stay references (<Code>{'${secret:NAME}'}</Code>).
        </Text>
      </Card>
    </Stack>
  );
}

export function DeletedAdmin() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['deleted-entities', page],
    queryFn: () => api.deletedEntities({ limit: PAGE, offset: (page - 1) * PAGE }),
    placeholderData: keepPreviousData,
  });
  const act = async (fn: () => Promise<unknown>, message: string) => {
    try {
      await fn();
      notifications.show({ message });
      void qc.invalidateQueries({ queryKey: ['deleted-entities'] });
      void qc.invalidateQueries({ queryKey: ['entities'] });
    } catch (e) {
      notifications.show({ color: 'red', message: errorText(e) });
    }
  };
  return (
    <Stack>
      <PageHeader
        title="Deleted entities"
        description="Deleted entities stay restorable until their retention period ends, then they are purged. Restoring puts back the entity as it was when deleted."
      />
      <DataTable
        rows={q.data?.items}
        loading={q.isPending}
        error={q.error}
        rowKey={(t) => `${t.blueprint}/${t.identifier}`}
        empty="Nothing was deleted recently"
        page={{ page, pageSize: PAGE, total: q.data?.total ?? 0, onChange: setPage }}
        columns={[
          {
            key: 'n',
            label: 'Entity',
            render: (t) => (
              <Text fz="sm" fw={500}>
                {t.title}
              </Text>
            ),
          },
          { key: 'b', label: 'Blueprint', render: (t) => <Badge color="gray">{t.blueprint}</Badge> },
          { key: 'i', label: 'Identifier', render: (t) => <Mono>{t.identifier}</Mono> },
          { key: 'by', label: 'Deleted by', render: (t) => t.deletedBy ?? 'system' },
          { key: 'at', label: 'Deleted', render: (t) => <TimeAgo at={t.deletedAt} /> },
          { key: 'ex', label: 'Purged', render: (t) => <TimeAgo at={t.expiresAt} /> },
          {
            key: 'x',
            label: '',
            width: 180,
            render: (t) => (
              <Group gap="xs" wrap="nowrap">
                <Button
                  size="compact-xs"
                  variant="light"
                  leftSection={<IconArrowBackUp size={14} />}
                  onClick={() => act(() => api.restoreEntity(t.blueprint, t.identifier), `${t.title} restored`)}
                >
                  Restore
                </Button>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="red"
                  leftSection={<IconTrash size={14} />}
                  onClick={() => act(() => api.purgeEntity(t.blueprint, t.identifier), `${t.title} purged`)}
                >
                  Purge
                </Button>
              </Group>
            ),
          },
        ]}
      />
    </Stack>
  );
}

/** Deliveries of every webhook that did not go through, with bulk redeliver. */
export function DeliveriesAdmin() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<string>('failed');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const q = useQuery({ queryKey: ['deliveries', 'all', status], queryFn: () => api.allDeliveries({ status, limit: 100 }) });
  const redeliver = useAppMutation({
    mutationFn: (ids: string[]) => api.redeliverMany(ids),
    onSuccess: (r) => {
      notifications.show({ color: 'green', message: `${r.queued} deliveries queued` });
      setSelected(new Set());
      void qc.invalidateQueries({ queryKey: ['deliveries'] });
    },
  });
  return (
    <Stack>
      <PageHeader
        title="Webhook deliveries"
        description="Outbound events across all webhooks."
        actions={
          <Button disabled={!selected.size} loading={redeliver.isPending} onClick={() => redeliver.mutate([...selected])}>
            Redeliver {selected.size || ''}
          </Button>
        }
      />
      <Select
        aria-label="Status"
        allowDeselect={false}
        data={[
          { value: 'failed', label: 'Failed' },
          { value: 'pending', label: 'Pending' },
          { value: 'success', label: 'Delivered' },
        ]}
        value={status}
        onChange={(v) => {
          setStatus(v ?? 'failed');
          setSelected(new Set());
        }}
        w={200}
      />
      <DataTable
        rows={q.data}
        loading={q.isPending}
        error={q.error}
        rowKey={(d) => d.id}
        empty="No deliveries"
        selection={{ selected, onChange: setSelected }}
        columns={[
          { key: 'w', label: 'When', render: (d) => <TimeAgo at={d.createdAt} /> },
          { key: 'h', label: 'Webhook', render: (d) => <Mono>{d.webhook}</Mono> },
          { key: 'e', label: 'Event', render: (d) => <Text fz="sm">{d.event}</Text> },
          { key: 'a', label: 'Attempts', render: (d) => d.attempts },
          { key: 'r', label: 'Response', render: (d) => d.responseStatus ?? '—' },
          {
            key: 'x',
            label: 'Error',
            render: (d) => (
              <Text fz="xs" c="red">
                {d.lastError ?? ''}
              </Text>
            ),
          },
        ]}
      />
    </Stack>
  );
}
