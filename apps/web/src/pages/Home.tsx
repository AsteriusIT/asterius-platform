import type { ReactNode } from 'react';
import { Anchor, Card, Group, SimpleGrid, Stack, Text, ThemeIcon, Title, UnstyledButton } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { IconChecklist } from '@tabler/icons-react';
import type { HomeSummary, WaitingOn } from '@asterius/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { EntityIcon } from '../components/icons';
import { DashboardView } from '../components/DashboardView';
import { DataTable } from '../components/DataTable';
import { QueryView, StatusBadge, TimeAgo } from '../components/ui';

/** "waiting on team payments, carol@example.com" */
export const waitingOnText = (w?: WaitingOn | null) => {
  const parts = [...(w?.teams ?? []).map((t) => `team ${t}`), ...(w?.users ?? []), ...(w?.roles ?? []).map((r) => `role ${r}`)];
  return parts.length ? `waiting on ${parts.join(', ')}` : 'waiting';
};

/** A compact list of a strip card, one line per item. */
function StripList<T>({ items, empty, render }: { items: T[]; empty: string; render: (item: T) => ReactNode }) {
  if (!items.length)
    return (
      <Text fz="sm" c="dimmed">
        {empty}
      </Text>
    );
  return <Stack gap={6}>{items.map(render)}</Stack>;
}

function StripCard({ title, to, linkLabel, children }: { title: string; to: string; linkLabel: string; children: ReactNode }) {
  return (
    <Card padding="md" component="section" aria-label={title}>
      <Group justify="space-between" mb="xs" wrap="nowrap" gap="xs">
        <Text fw={600} fz="sm" truncate>
          {title}
        </Text>
        <Anchor component={Link} to={to} fz="xs" style={{ flexShrink: 0 }}>
          {linkLabel}
        </Anchor>
      </Group>
      {children}
    </Card>
  );
}

/** The caller's own corner, shown above any dashboard: decisions to make, requests waiting on others, latest runs, team changes. */
export function PersonalStrip({ home }: { home: HomeSummary }) {
  const decisions = home.pendingApprovals;
  return (
    <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
      <StripCard title="Waiting for your decision" to="/todo" linkLabel="Open to do">
        <Group gap="sm" wrap="nowrap">
          <ThemeIcon variant="light" size="lg" color={decisions ? 'yellow' : 'gray'}>
            <IconChecklist size={18} />
          </ThemeIcon>
          <div>
            <Text fz={26} fw={700} lh={1}>
              {decisions > 99 ? '99+' : decisions}
            </Text>
            <Text fz="xs" c="dimmed">
              {decisions ? (decisions === 1 ? 'decision to make' : 'decisions to make') : 'You are all caught up'}
            </Text>
          </div>
        </Group>
      </StripCard>
      <StripCard title={`Your requests waiting on others (${home.waitingOnOthers.length})`} to="/todo" linkLabel="See all">
        <StripList
          items={home.waitingOnOthers.slice(0, 4)}
          empty="None of your requests is waiting."
          render={(r) => (
            <Anchor key={`${r.id}/${r.pendingStep?.id ?? ''}`} component={Link} to={`/runs/${r.id}`} c="inherit" display="block">
              <Text fz="sm" fw={500} truncate>
                {r.actionTitle}
              </Text>
              <Text fz="xs" c="dimmed" truncate>
                {r.pendingStep ? r.pendingStep.name : 'Approval'} · {waitingOnText(r.waitingOn)}
              </Text>
            </Anchor>
          )}
        />
      </StripCard>
      <StripCard title="Your latest runs" to="/runs?scope=mine" linkLabel="All runs">
        <StripList
          items={home.myRuns.slice(0, 4)}
          empty="No runs yet: start from Self-service."
          render={(r) => (
            <Group key={r.id} justify="space-between" wrap="nowrap" gap="xs">
              <Anchor component={Link} to={`/runs/${r.id}`} fz="sm" truncate style={{ minWidth: 0 }}>
                {r.actionTitle}
                {r.entity ? ` · ${r.entity}` : ''}
              </Anchor>
              <StatusBadge status={r.status} />
            </Group>
          )}
        />
      </StripCard>
      <StripCard title="Changed in your teams" to="/catalog" linkLabel="Catalog">
        <StripList
          items={home.teamEntities.slice(0, 4)}
          empty="Nothing owned by your teams changed recently."
          render={(e) => (
            <Group key={`${e.blueprint}/${e.identifier}`} justify="space-between" wrap="nowrap" gap="xs">
              <Anchor component={Link} to={`/catalog/${e.blueprint}/${encodeURIComponent(e.identifier)}`} fz="sm" truncate style={{ minWidth: 0 }}>
                {e.title}
              </Anchor>
              <Text fz="xs" c="dimmed" style={{ flexShrink: 0 }}>
                <TimeAgo at={e.updatedAt} />
              </Text>
            </Group>
          )}
        />
      </StripCard>
    </SimpleGrid>
  );
}

export function Home() {
  const { user } = useAuth();
  const q = useQuery({ queryKey: ['home'], queryFn: api.home, refetchInterval: 30_000 });
  const navigate = useNavigate();
  // A dashboard (of the viewer's team, else the default one) replaces the built-in catalog summary; the personal strip stays.
  const dashboard = useQuery({ queryKey: ['dashboard-resolve', 'home'], queryFn: () => api.resolveDashboard() });
  return (
    <Stack gap="lg">
      <div>
        <Title order={2}>Hello {user?.name.split(' ')[0]}</Title>
        <Text c="dimmed">Everything your teams build and run, and the golden paths to change it.</Text>
      </div>
      <QueryView q={q}>{(home) => <PersonalStrip home={home} />}</QueryView>
      {dashboard.data && <DashboardView dashboard={dashboard.data} />}
      {dashboard.isFetched && !dashboard.data && q.data && (
        <>
          <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }}>
            {q.data.blueprints.map((b) => (
              <UnstyledButton key={b.identifier} component={Link} to={`/catalog/${b.identifier}`}>
                <Card padding="md" className="hover-card">
                  <Group justify="space-between" wrap="nowrap">
                    <ThemeIcon variant="light" size="lg">
                      <EntityIcon name={b.icon} />
                    </ThemeIcon>
                    <Text fz={26} fw={700}>
                      {b.count}
                    </Text>
                  </Group>
                  <Text mt="xs" fw={500} truncate>
                    {b.title}
                  </Text>
                </Card>
              </UnstyledButton>
            ))}
          </SimpleGrid>
          <div>
            <Title order={4} mb="xs">
              Recently changed in the catalog
            </Title>
            <DataTable
              rows={q.data.recentEntities}
              rowKey={(e) => `${e.blueprint}/${e.identifier}`}
              onRowClick={(e) => navigate(`/catalog/${e.blueprint}/${encodeURIComponent(e.identifier)}`)}
              columns={[
                {
                  key: 'n',
                  label: 'Entity',
                  render: (e) => (
                    <Text fz="sm" fw={500}>
                      {e.title}
                    </Text>
                  ),
                },
                {
                  key: 'b',
                  label: 'Type',
                  render: (e) => (
                    <Text fz="sm" c="dimmed">
                      {e.blueprint}
                    </Text>
                  ),
                },
                { key: 't', label: 'Updated', render: (e) => <TimeAgo at={e.updatedAt} /> },
              ]}
            />
          </div>
        </>
      )}
    </Stack>
  );
}
