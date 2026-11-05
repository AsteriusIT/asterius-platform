import { Alert, Anchor, Card, Grid, Group, SimpleGrid, Stack, Text, ThemeIcon, Title, UnstyledButton } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { IconChecklist } from '@tabler/icons-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { EntityIcon } from '../components/icons';
import { DataTable } from '../components/DataTable';
import { Empty, QueryView, StatusBadge, TimeAgo } from '../components/ui';

export function Home() {
  const { user } = useAuth();
  const q = useQuery({ queryKey: ['home'], queryFn: api.home, refetchInterval: 30_000 });
  const navigate = useNavigate();
  return (
    <Stack gap="lg">
      <div>
        <Title order={2}>Hello {user?.name.split(' ')[0]}</Title>
        <Text c="dimmed">Everything your teams build and run, and the golden paths to change it.</Text>
      </div>
      <QueryView q={q}>
        {(home) => (
          <>
            {home.pendingApprovals > 0 && (
              <Alert color="yellow" icon={<IconChecklist size={18} />} title={`${home.pendingApprovals} request(s) waiting for your approval`}>
                <Anchor component={Link} to="/approvals">
                  Review them
                </Anchor>
              </Alert>
            )}
            <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }}>
              {home.blueprints.map((b) => (
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
            <Grid>
              <Grid.Col span={{ base: 12, md: 6 }}>
                <Group justify="space-between" mb="xs">
                  <Title order={4}>My recent runs</Title>
                  <Anchor component={Link} to="/self-service" fz="sm">
                    New request
                  </Anchor>
                </Group>
                <DataTable
                  rows={home.myRuns}
                  rowKey={(r) => r.id}
                  onRowClick={(r) => navigate(`/runs/${r.id}`)}
                  empty={<Empty title="No runs yet">Start from the self-service page.</Empty>}
                  columns={[
                    {
                      key: 'a',
                      label: 'Action',
                      render: (r) => (
                        <Text fz="sm" fw={500}>
                          {r.actionTitle}
                          {r.entity ? ` · ${r.entity}` : ''}
                        </Text>
                      ),
                    },
                    { key: 's', label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
                    { key: 't', label: 'When', render: (r) => <TimeAgo at={r.createdAt} /> },
                  ]}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, md: 6 }}>
                <Title order={4} mb="xs">
                  Recently changed in the catalog
                </Title>
                <DataTable
                  rows={home.recentEntities}
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
              </Grid.Col>
            </Grid>
          </>
        )}
      </QueryView>
    </Stack>
  );
}
