import { useEffect, useState } from 'react';
import { ActionIcon, Badge, Button, Card, Group, SimpleGrid, Stack, Text, TextInput, ThemeIcon, Title, Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { loadFavourites, loadRecent, parseInputsParam, toggleFavourite } from '../lib/drafts';
import { IconSearch, IconShieldCheck, IconStar, IconStarFilled } from '@tabler/icons-react';
import type { Action } from '@asterius/shared';
import { api, type ActionView } from '../lib/api';
import { workflowSummary } from '../lib/workflow';
import { formOf, isRunnable } from '../lib/permissions';
import { ActionRunModal } from '../components/ActionRunModal';
import { EntityIcon } from '../components/icons';
import { Empty, PageHeader, QueryView } from '../components/ui';

/** Golden paths: every "create" action, grouped by blueprint. Day-2 actions live on entity pages. */
export function SelfService() {
  const actions = useQuery({ queryKey: ['actions', 'create'], queryFn: () => api.actions({ trigger: 'create' }) });
  const blueprints = useQuery({ queryKey: ['blueprints'], queryFn: api.blueprints, staleTime: 30_000 });
  const [run, setRun] = useState<Action | null>(null);
  const [filter, setFilter] = useState('');
  const [favourites, setFavourites] = useState(loadFavourites);
  const [params, setParams] = useSearchParams();
  const prefill = parseInputsParam(params.get('inputs'));
  const wanted = params.get('action');
  // ?action=<id>&inputs=<json> opens the form prefilled (shareable links, "run again").
  useEffect(() => {
    const a = actions.data?.find((x) => x.identifier === wanted);
    if (a) setRun(a);
  }, [actions.data, wanted]);
  const closeRun = () => {
    setRun(null);
    if (wanted) setParams({}, { replace: true });
  };

  return (
    <Stack>
      <PageHeader title="Self-service" description="Request infrastructure and changes through the platform's golden paths." refresh={actions} />
      <TextInput
        placeholder="Filter actions"
        leftSection={<IconSearch size={16} />}
        value={filter}
        onChange={(e) => setFilter(e.currentTarget.value)}
        maw={360}
      />
      <QueryView q={actions}>
        {(list) => {
          const visible = list.filter((a) => isRunnable(a) && `${a.title} ${a.description}`.toLowerCase().includes(filter.toLowerCase()));
          if (!visible.length) return <Empty title="No self-service action" />;
          const recent = loadRecent()
            .map((id) => visible.find((a) => a.identifier === id))
            .filter((a): a is ActionView => !!a);
          const groups = new Map<string, ActionView[]>();
          const sorted = [...visible].sort((a, b) => Number(favourites.includes(b.identifier)) - Number(favourites.includes(a.identifier)));
          for (const a of sorted) groups.set(formOf(a)?.blueprint ?? '', [...(groups.get(formOf(a)?.blueprint ?? '') ?? []), a]);
          const groupsView = [...groups.entries()].map(([bp, items]) => {
            const b = blueprints.data?.find((x) => x.identifier === bp);
            return (
              <Stack key={bp} gap="xs">
                <Title order={5} c="dimmed" fz="sm" fw={500}>
                  {b?.title ?? (bp || 'General')}
                </Title>
                <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
                  {items.map((a) => (
                    <Card key={a.identifier} className="hover-card" style={{ display: 'flex', flexDirection: 'column' }}>
                      <Group justify="space-between" align="flex-start" wrap="nowrap">
                        <Group gap="sm" wrap="nowrap">
                          <ThemeIcon variant="light" size="lg">
                            <EntityIcon name={a.icon ?? b?.icon} />
                          </ThemeIcon>
                          <Text fw={600}>{a.title}</Text>
                        </Group>
                        <ActionIcon
                          variant="subtle"
                          color={favourites.includes(a.identifier) ? 'yellow' : 'gray'}
                          aria-label={`${favourites.includes(a.identifier) ? 'Remove from' : 'Add to'} favourites: ${a.title}`}
                          aria-pressed={favourites.includes(a.identifier)}
                          onClick={() => setFavourites(toggleFavourite(a.identifier))}
                        >
                          {favourites.includes(a.identifier) ? <IconStarFilled size={16} /> : <IconStar size={16} />}
                        </ActionIcon>
                        {formOf(a)?.approval.required && (
                          <Tooltip label="Requires approval">
                            <Badge color="yellow" leftSection={<IconShieldCheck size={12} />} style={{ flexShrink: 0 }}>
                              approval
                            </Badge>
                          </Tooltip>
                        )}
                      </Group>
                      <Text fz="sm" c="dimmed" mt="sm" lineClamp={3} style={{ flex: 1 }}>
                        {a.description}
                      </Text>
                      <Group justify="space-between" mt="md">
                        <Badge color="gray" variant="outline" size="sm">
                          {workflowSummary(a)}
                        </Badge>
                        <Tooltip label="You are not allowed to run this action" disabled={a.allowedForMe}>
                          <Button size="xs" disabled={!a.allowedForMe} onClick={() => setRun(a)}>
                            Start
                          </Button>
                        </Tooltip>
                      </Group>
                    </Card>
                  ))}
                </SimpleGrid>
              </Stack>
            );
          });
          return (
            <>
              {recent.length > 0 && !filter && (
                <Group gap="xs">
                  <Text fz="sm" c="dimmed">
                    Recent
                  </Text>
                  {recent.map((a) => (
                    <Button key={a.identifier} size="compact-sm" variant="default" disabled={!a.allowedForMe} onClick={() => setRun(a)}>
                      {a.title}
                    </Button>
                  ))}
                </Group>
              )}
              {groupsView}
            </>
          );
        }}
      </QueryView>
      <ActionRunModal action={run} prefill={prefill} onClose={closeRun} />
    </Stack>
  );
}
