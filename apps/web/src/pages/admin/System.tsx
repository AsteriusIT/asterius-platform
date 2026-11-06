import { useState } from 'react';
import { Badge, Button, Card, Code, Group, SimpleGrid, Stack, Text, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconArrowBackUp, IconDownload, IconRefresh, IconSearch, IconTrash } from '@tabler/icons-react';
import { api, errorText } from '../../lib/api';
import { DataTable } from '../../components/DataTable';
import { Mono, PageHeader, QueryView, TimeAgo } from '../../components/ui';

const PAGE = 50;

export function AuditAdmin() {
  const [search, setSearch] = useState('');
  const [debounced] = useDebouncedValue(search, 300);
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['audit', debounced, page],
    queryFn: () => api.audit({ search: debounced, limit: PAGE + 1, offset: (page - 1) * PAGE }),
    placeholderData: keepPreviousData,
  });
  const rows = q.data?.slice(0, PAGE);
  return (
    <Stack>
      <PageHeader title="Audit log" description="Who changed what: definitions, catalog writes, runs, approvals, tokens, secrets, sign-ins." />
      <TextInput
        placeholder="Filter by action, target or user"
        leftSection={<IconSearch size={16} />}
        value={search}
        onChange={(e) => {
          setSearch(e.currentTarget.value);
          setPage(1);
        }}
        maw={400}
      />
      <DataTable
        rows={rows}
        loading={q.isPending}
        error={q.error}
        rowKey={(a) => a.id}
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
          { key: 'd', label: 'Detail', render: (a) => (Object.keys(a.detail).length ? <Code fz="xs">{JSON.stringify(a.detail)}</Code> : '') },
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
  const [busy, setBusy] = useState(false);

  const download = async () => {
    const yaml = await api.configExport();
    const url = URL.createObjectURL(new Blob([yaml], { type: 'text/yaml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `asterius-config-${new Date().toISOString().slice(0, 10)}.yaml`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const reload = async () => {
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
            <Button variant="default" leftSection={<IconRefresh size={16} />} loading={busy} onClick={reload}>
              Reload now
            </Button>
            <Button leftSection={<IconDownload size={16} />} onClick={() => void download()}>
              Export YAML
            </Button>
          </>
        }
      />
      <QueryView q={info}>
        {(i) => (
          <>
            <Text fz="sm">
              Directory: <Code>{i.dir}</Code>
            </Text>
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
