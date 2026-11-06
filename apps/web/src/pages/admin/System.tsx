import { useState } from 'react';
import { Alert, Badge, Button, Card, Code, Group, SimpleGrid, Stack, Text, TextInput } from '@mantine/core';
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
  const status = useQuery({ queryKey: ['config-status'], queryFn: api.configStatus, refetchInterval: 30_000 });
  const plan = useQuery({ queryKey: ['config-plan'], queryFn: api.configPlan });
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
