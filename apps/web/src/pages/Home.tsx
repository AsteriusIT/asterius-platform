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
import { QueryView, StatusBadge, StatValue, TimeAgo } from '../components/ui';

/** "waiting on team payments, carol@example.com" */
export const waitingOnText = (w?: WaitingOn | null) => {
  const parts = [...(w?.teams ?? []).map((t) => `team ${t}`), ...(w?.users ?? []), ...(w?.roles ?? []).map((r) => `role ${r}`)];
  return parts.length ? `waiting on ${parts.join(', ')}` : 'waiting';
};

/** Widths of the page panel from which the personal strip has two, then four columns (container query). */
const STRIP_2_COLS = '560px';
const STRIP_4_COLS = '1160px';

/** A compact list of a strip card, one line per item. */
function StripList<T>({ items, empty, render }: { items: T[]; empty: string; render: (item: T) => ReactNode }) {
  if (!items.length)
    return (
      <Text fz="sm" c="dimmed">
        {empty}
      </Text>
    );
  return <Stack gap="2xs">{items.map(render)}</Stack>;
}

/** `title` is short enough for a quarter of the page; `label` names the card in full for assistive technology. */
function StripCard({ title, label, to, linkLabel, children }: { title: string; label: string; to: string; linkLabel: string; children: ReactNode }) {
  return (
    <Card padding="md" component="section" aria-label={label}>
      <Group justify="space-between" mb="xs" wrap="nowrap" gap="xs">
        <Text fw={600} fz="sm" truncate title={label}>
          {title}
        </Text>
        <Anchor component={Link} to={to} fz="xs" flex="none">
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
    // Columns follow the width of the page panel, not of the window: two until there is room for four (sidebar open or folded).
    <SimpleGrid type="container" cols={{ base: 1, [STRIP_2_COLS]: 2, [STRIP_4_COLS]: 4 }}>
      <StripCard title="Waiting for you" label="Waiting for your decision" to="/todo" linkLabel="Open to do">
        <Group gap="sm" wrap="nowrap">
          <ThemeIcon variant="light" size="lg" color={decisions ? 'yellow' : 'gray'}>
            <IconChecklist size={18} />
          </ThemeIcon>
          <div>
            <StatValue lh={1}>{decisions > 99 ? '99+' : decisions}</StatValue>
            <Text fz="xs" c="dimmed">
              {decisions ? (decisions === 1 ? 'decision to make' : 'decisions to make') : 'You are all caught up'}
            </Text>
          </div>
        </Group>
      </StripCard>
      <StripCard
        title={`Waiting on others (${home.waitingOnOthers.length})`}
        label={`Your requests waiting on others (${home.waitingOnOthers.length})`}
        to="/todo"
        linkLabel="See all"
      >
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
      <StripCard title="Your latest runs" label="Your latest runs" to="/runs?scope=mine" linkLabel="All runs">
        <StripList
          items={home.myRuns.slice(0, 4)}
          empty="No runs yet: start from Self-service."
          render={(r) => (
            <Group key={r.id} justify="space-between" wrap="nowrap" gap="xs">
              <Anchor component={Link} to={`/runs/${r.id}`} fz="sm" truncate miw={0} title={`${r.actionTitle}${r.entity ? ` · ${r.entity}` : ''}`}>
                {r.actionTitle}
                {r.entity ? ` · ${r.entity}` : ''}
              </Anchor>
              <StatusBadge status={r.status} />
            </Group>
          )}
        />
      </StripCard>
      <StripCard title="Changed in your teams" label="Changed in your teams" to="/catalog" linkLabel="Catalog">
        <StripList
          items={home.teamEntities.slice(0, 4)}
          empty="Nothing owned by your teams changed recently."
          render={(e) => (
            <Group key={`${e.blueprint}/${e.identifier}`} justify="space-between" wrap="nowrap" gap="xs">
              <Anchor component={Link} to={`/catalog/${e.blueprint}/${encodeURIComponent(e.identifier)}`} fz="sm" truncate miw={0}>
                {e.title}
              </Anchor>
              <Text fz="xs" c="dimmed" flex="none">
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
                    <StatValue>{b.count}</StatValue>
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
