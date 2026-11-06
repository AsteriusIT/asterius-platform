import { useState } from 'react';
import { ActionIcon, Button, Card, Group, NumberInput, Select, SimpleGrid, Stack, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconTrash } from '@tabler/icons-react';
import type { AiBudget } from '@asterius/shared';
import { api, errorText } from '../../lib/api';
import { DataTable } from '../../components/DataTable';
import { Mono, PageHeader, QueryView } from '../../components/ui';

const usd = (n: number | null | undefined) => (n == null ? 'no limit' : `$${n.toFixed(n < 1 ? 4 : 2)}`);

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <Card padding="md">
      <Text fz={24} fw={700}>
        {value}
      </Text>
      <Text fz="sm" c="dimmed">
        {label}
      </Text>
    </Card>
  );
}

/** Admin → AI: spend this month, budgets (soft = warning in the run log, hard = the step fails) and the price table. */
export function AiAdmin() {
  const qc = useQueryClient();
  const usage = useQuery({ queryKey: ['ai-usage'], queryFn: api.aiUsage });
  const budgets = useQuery({ queryKey: ['ai-budgets'], queryFn: api.aiBudgets });
  const prices = useQuery({ queryKey: ['ai-prices'], queryFn: api.aiPrices });
  const [scope, setScope] = useState<AiBudget['scope']>('global');
  const [key, setKey] = useState('');
  const [soft, setSoft] = useState<number | string>('');
  const [hard, setHard] = useState<number | string>('');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['ai-budgets'] });
  const onError = (e: unknown) => notifications.show({ color: 'red', message: errorText(e) });
  const save = useMutation({
    mutationFn: () =>
      api.setAiBudget({
        scope,
        key: scope === 'action' || scope === 'team' ? key : '*',
        softUsd: soft === '' ? null : Number(soft),
        hardUsd: hard === '' ? null : Number(hard),
      }),
    onSuccess: () => {
      refresh();
      setSoft('');
      setHard('');
    },
    onError,
  });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteAiBudget(id), onSuccess: refresh, onError });
  const needsKey = scope === 'action' || scope === 'team';

  return (
    <Stack>
      <PageHeader title="AI usage and budgets" description="Every model call is metered. Budgets apply per calendar month (per run for the run scope)." />
      <QueryView q={usage}>
        {(u) => (
          <>
            <SimpleGrid cols={{ base: 2, sm: 4 }}>
              <Stat value={usd(u.totals.costUsd)} label="spent this month" />
              <Stat value={String(u.totals.calls)} label="model calls" />
              <Stat value={String(u.totals.failed)} label="failed or refused calls" />
              <Stat value={`${Math.round((u.totals.inputTokens + u.totals.outputTokens) / 1000)}k`} label="tokens (excluding cache)" />
            </SimpleGrid>
            <SimpleGrid cols={{ base: 1, md: 3 }}>
              <DataTable
                rows={u.byAction}
                loading={false}
                error={null}
                rowKey={(r) => r.key ?? '-'}
                columns={[
                  { key: 'k', label: 'Action', render: (r) => <Mono>{r.key ?? 'assistant'}</Mono> },
                  { key: 'c', label: 'Cost', render: (r) => usd(r.costUsd) },
                ]}
              />
              <DataTable
                rows={u.byTeam}
                loading={false}
                error={null}
                rowKey={(r) => r.key ?? '-'}
                columns={[
                  { key: 'k', label: 'Team', render: (r) => <Mono>{r.key ?? 'none'}</Mono> },
                  { key: 'c', label: 'Cost', render: (r) => usd(r.costUsd) },
                ]}
              />
              <DataTable
                rows={u.byModel}
                loading={false}
                error={null}
                rowKey={(r) => r.model}
                columns={[
                  { key: 'k', label: 'Model', render: (r) => <Mono>{r.model}</Mono> },
                  { key: 'c', label: 'Cost', render: (r) => usd(r.costUsd) },
                ]}
              />
            </SimpleGrid>
          </>
        )}
      </QueryView>

      <Card>
        <Text fw={600} mb="xs">
          Budgets
        </Text>
        <Group align="flex-end" mb="md">
          <Select
            label="Scope"
            allowDeselect={false}
            data={[
              { value: 'global', label: 'Platform (month)' },
              { value: 'action', label: 'Action (month)' },
              { value: 'team', label: 'Team (month)' },
              { value: 'run', label: 'Each run' },
            ]}
            value={scope}
            onChange={(v) => setScope((v as AiBudget['scope']) ?? 'global')}
          />
          {needsKey && (
            <TextInput label={scope === 'action' ? 'Action identifier' : 'Team identifier'} value={key} onChange={(e) => setKey(e.currentTarget.value)} />
          )}
          <NumberInput label="Soft limit ($)" min={0} decimalScale={2} value={soft} onChange={setSoft} />
          <NumberInput label="Hard limit ($)" min={0} decimalScale={2} value={hard} onChange={setHard} />
          <Button loading={save.isPending} disabled={needsKey && !key} onClick={() => save.mutate()}>
            Save budget
          </Button>
        </Group>
        <DataTable
          rows={budgets.data}
          loading={budgets.isPending}
          error={budgets.error}
          rowKey={(b) => b.id}
          columns={[
            { key: 's', label: 'Scope', render: (b) => <Mono>{b.scope === 'global' || b.scope === 'run' ? b.scope : `${b.scope}:${b.key}`}</Mono> },
            { key: 'a', label: 'Soft (warning)', render: (b) => usd(b.softUsd) },
            { key: 'h', label: 'Hard (stops AI calls)', render: (b) => usd(b.hardUsd) },
            {
              key: 'x',
              label: '',
              render: (b) => (
                <ActionIcon variant="subtle" color="red" aria-label="Delete budget" onClick={() => remove.mutate(b.id)}>
                  <IconTrash size={16} />
                </ActionIcon>
              ),
            },
          ]}
        />
      </Card>

      <Card>
        <Text fw={600} mb="xs">
          Prices ($ per million tokens)
        </Text>
        <DataTable
          rows={prices.data}
          loading={prices.isPending}
          error={prices.error}
          rowKey={(p) => p.model}
          columns={[
            { key: 'm', label: 'Model', render: (p) => <Mono>{p.model}</Mono> },
            { key: 'i', label: 'Input', render: (p) => p.input },
            { key: 'o', label: 'Output', render: (p) => p.output },
            { key: 'w', label: 'Cache write', render: (p) => p.cacheWrite },
            { key: 'r', label: 'Cache read', render: (p) => p.cacheRead },
            { key: 's', label: 'Source', render: (p) => p.source },
          ]}
        />
      </Card>
    </Stack>
  );
}
