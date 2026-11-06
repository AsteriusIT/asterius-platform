import { useState } from 'react';
import { Button, Card, Code, Group, SimpleGrid, Stack, Text, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconDownload, IconRefresh, IconSearch } from '@tabler/icons-react';
import { api, errorText } from '../../lib/api';
import { DataTable } from '../../components/DataTable';
import { Mono, PageHeader, QueryView, TimeAgo } from '../../components/ui';

const PAGE = 50;

export function AuditAdmin() {
  const [search, setSearch] = useState('');
  const [debounced] = useDebouncedValue(search, 300);
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [dAction] = useDebouncedValue(action, 300);
  const [dActor] = useDebouncedValue(actor, 300);
  const [page, setPage] = useState(1);
  const filters = { search: debounced, action: dAction, actor: dActor };
  const exportAs = async (format: 'csv' | 'json') => {
    const body = await api.auditExport(filters, format);
    const url = URL.createObjectURL(new Blob([body], { type: format === 'csv' ? 'text/csv' : 'application/x-ndjson' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `asterius-audit-${new Date().toISOString().slice(0, 10)}.${format === 'csv' ? 'csv' : 'ndjson'}`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const q = useQuery({
    queryKey: ['audit', debounced, dAction, dActor, page],
    queryFn: () => api.audit({ ...filters, limit: PAGE + 1, offset: (page - 1) * PAGE }),
    placeholderData: keepPreviousData,
  });
  const rows = q.data?.slice(0, PAGE);
  return (
    <Stack>
      <PageHeader title="Audit log" description="Who changed what: definitions, catalog writes, runs, approvals, tokens, secrets, sign-ins." />
      <Group align="flex-end">
        <TextInput
          placeholder="Filter by action, target or user"
          leftSection={<IconSearch size={16} />}
          value={search}
          onChange={(e) => {
            setSearch(e.currentTarget.value);
            setPage(1);
          }}
          w={300}
        />
        <TextInput
          placeholder="Action (token.*)"
          value={action}
          onChange={(e) => {
            setAction(e.currentTarget.value);
            setPage(1);
          }}
          w={160}
        />
        <TextInput
          placeholder="Actor email"
          value={actor}
          onChange={(e) => {
            setActor(e.currentTarget.value);
            setPage(1);
          }}
          w={200}
        />
        <Button variant="default" leftSection={<IconDownload size={16} />} onClick={() => void exportAs('csv')}>
          CSV
        </Button>
        <Button variant="default" leftSection={<IconDownload size={16} />} onClick={() => void exportAs('json')}>
          NDJSON
        </Button>
      </Group>
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
