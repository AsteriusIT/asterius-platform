import { useState } from 'react';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  Code,
  Group,
  Modal,
  MultiSelect,
  PasswordInput,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import type { PublicUser, Team } from '@asterius/shared';
import { api, errorText } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataTable } from '../../components/DataTable';
import { Mono, PageHeader, TimeAgo } from '../../components/ui';
import { NewTokenAlert, TokenTable } from '../Profile';
import { ResourceAdmin, strip } from './ResourceAdmin';
import { TeamBuilder } from '../../components/builder/SimpleBuilders';
import { DelegationsTable } from '../../components/DelegationCard';

export function TeamsAdmin() {
  return (
    <ResourceAdmin<Team>
      title="Teams"
      description="Teams own entities and approve requests. Bind a team to an Entra ID group to manage membership there."
      queryKey="teams"
      list={api.teams}
      columns={[
        {
          key: 'm',
          label: 'Members',
          render: (t) => (
            <Avatar.Group>
              {t.members.slice(0, 6).map((m) => (
                <Tooltip key={m.id} label={m.name}>
                  <Avatar size="sm" radius="xl" color="indigo">
                    {m.name.slice(0, 2).toUpperCase()}
                  </Avatar>
                </Tooltip>
              ))}
              {t.members.length > 6 && (
                <Avatar size="sm" radius="xl">
                  +{t.members.length - 6}
                </Avatar>
              )}
            </Avatar.Group>
          ),
        },
        { key: 'g', label: 'Entra group', render: (t) => (t.entraGroupId ? <Mono>{t.entraGroupId}</Mono> : '—') },
      ]}
      templates={[{ label: 'Team', value: { identifier: '', title: '', description: '', entraGroupId: null } }]}
      editor={(p) => <TeamBuilder {...p} />}
      toEditable={(t) => strip(t, ['managed', 'members'])}
      save={api.saveTeam}
      remove={(t) => api.deleteTeam(t.identifier)}
      removeWarning={() => 'Only possible when the team owns no entity.'}
    />
  );
}

export function UsersAdmin() {
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const users = useQuery({ queryKey: ['users'], queryFn: api.users });
  const teams = useQuery({ queryKey: ['teams'], queryFn: api.teams });
  const [filter, setFilter] = useState('');
  const [debounced] = useDebouncedValue(filter, 200);
  const [creating, setCreating] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { role?: string; active?: boolean; teams?: string[] } }) => api.updateUser(id, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['users'] }),
    onError: (e) => notifications.show({ color: 'red', message: errorText(e) }),
  });
  const teamOptions = (teams.data ?? []).map((t) => ({ value: t.identifier, label: t.title }));
  const rows = (users.data ?? []).filter((u) => `${u.name} ${u.email}`.toLowerCase().includes(debounced.toLowerCase()));

  return (
    <Stack>
      <PageHeader
        title="Users & service accounts"
        refresh={[users, teams]}
        description="Roles: admins manage the platform; members use it. Team membership drives ownership and approvals."
        actions={
          <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>
            Service account
          </Button>
        }
      />
      <NewTokenAlert token={token} onClose={() => setToken(null)} />
      <TextInput placeholder="Filter by name or email" value={filter} onChange={(e) => setFilter(e.currentTarget.value)} maw={360} />
      <DataTable<PublicUser>
        rows={rows}
        loading={users.isPending}
        error={users.error}
        rowKey={(u) => u.id}
        columns={[
          {
            key: 'n',
            label: 'User',
            render: (u) => (
              <div>
                <Text fz="sm" fw={500}>
                  {u.name}
                </Text>
                <Text fz="xs" c="dimmed">
                  {u.email}
                </Text>
              </div>
            ),
          },
          {
            key: 'p',
            label: 'Type',
            render: (u) => <Badge color={u.provider === 'service' ? 'cyan' : 'gray'}>{u.provider === 'service' ? 'service account' : u.provider}</Badge>,
          },
          {
            key: 'r',
            label: 'Role',
            render: (u) => (
              <Select
                size="xs"
                w={110}
                data={['member', 'admin']}
                value={u.role}
                disabled={u.id === me?.id}
                onChange={(v) => v && update.mutate({ id: u.id, patch: { role: v } })}
                allowDeselect={false}
              />
            ),
          },
          {
            key: 't',
            label: 'Teams',
            render: (u) => (
              <MultiSelect
                size="xs"
                miw={220}
                data={teamOptions}
                value={u.teams.map((t) => t.identifier)}
                onChange={(v) => update.mutate({ id: u.id, patch: { teams: v } })}
                placeholder="—"
              />
            ),
          },
          { key: 'l', label: 'Last sign-in', render: (u) => <TimeAgo at={u.lastLoginAt} /> },
          {
            key: 'a',
            label: 'Active',
            render: (u) => (
              <Switch checked={u.active} disabled={u.id === me?.id} onChange={(e) => update.mutate({ id: u.id, patch: { active: e.currentTarget.checked } })} />
            ),
          },
        ]}
      />
      <Title order={4} mt="md">
        All API tokens
      </Title>
      <TokenTable all />
      <ServiceAccountModal opened={creating} teams={teamOptions} onClose={() => setCreating(false)} onCreated={(t) => setToken(t)} />
    </Stack>
  );
}

function ServiceAccountModal({
  opened,
  teams,
  onClose,
  onCreated,
}: {
  opened: boolean;
  teams: { value: string; label: string }[];
  onClose: () => void;
  onCreated: (token: string) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [role, setRole] = useState('member');
  const [selected, setSelected] = useState<string[]>([]);
  const create = useMutation({
    mutationFn: () => api.createServiceAccount({ name, role, teams: selected }),
    onSuccess: (r) => {
      onCreated(r.token);
      void qc.invalidateQueries({ queryKey: ['users'] });
      void qc.invalidateQueries({ queryKey: ['tokens'] });
      setName('');
      onClose();
    },
  });
  return (
    <Modal opened={opened} onClose={onClose} title={<Text fw={600}>New service account</Text>}>
      <Stack>
        <Text fz="sm" c="dimmed">
          For CI pipelines and scripts that push entities or trigger actions. Members write entities of their teams; admins everything.
        </Text>
        <TextInput label="Name" placeholder="github-actions" value={name} onChange={(e) => setName(e.currentTarget.value)} required />
        <Select label="Role" data={['member', 'admin']} value={role} onChange={(v) => setRole(v ?? 'member')} allowDeselect={false} />
        <MultiSelect label="Teams" data={teams} value={selected} onChange={setSelected} />
        {create.error && (
          <Alert color="red" variant="light">
            {errorText(create.error)}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>
            Create
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function SecretsAdmin() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['secrets'], queryFn: api.secrets });
  const providers = useQuery({ queryKey: ['secret-providers'], queryFn: api.secretProviders });
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [description, setDescription] = useState('');
  const save = useMutation({
    mutationFn: () => api.setSecret(name.trim(), value, description),
    onSuccess: () => {
      notifications.show({ color: 'green', message: `Secret ${name} saved` });
      setName('');
      setValue('');
      setDescription('');
      void qc.invalidateQueries({ queryKey: ['secrets'] });
    },
  });
  return (
    <Stack>
      <PageHeader
        title="Secrets"
        refresh={q}
        description={
          <>
            Encrypted (AES-256-GCM) and only resolved at execution time. Reference them as <Code>{'${secret:NAME}'}</Code> in actions, integrations and
            webhooks. Values are never shown again.
          </>
        }
      />
      <Card>
        <Stack gap="3xs">
          <Text fw={600} fz="sm">
            External secret managers
          </Text>
          {(providers.data ?? []).map((p) => (
            <Group key={p.kind} gap="xs">
              <Text fz="sm" w={220}>
                {p.title}
              </Text>
              <Mono>{p.example}</Mono>
              <Text fz="xs" c={p.enabled ? 'green' : 'dimmed'}>
                {p.enabled ? 'configured' : 'not configured'}
              </Text>
            </Group>
          ))}
        </Stack>
      </Card>
      <Card>
        <Stack gap="sm">
          <Group grow align="flex-start">
            <TextInput label="Name" placeholder="GITHUB_TOKEN" value={name} onChange={(e) => setName(e.currentTarget.value)} />
            <PasswordInput label="Value" value={value} onChange={(e) => setValue(e.currentTarget.value)} autoComplete="off" />
          </Group>
          <Textarea
            label="Description"
            placeholder="What it is, who owns it, when it expires"
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
            autosize
          />
          {save.error && (
            <Text c="red" fz="sm">
              {errorText(save.error)}
            </Text>
          )}
          <Group justify="flex-end">
            <Button disabled={!name.trim() || !value} loading={save.isPending} onClick={() => save.mutate()}>
              Save secret
            </Button>
          </Group>
        </Stack>
      </Card>
      <DataTable
        rows={q.data}
        loading={q.isPending}
        error={q.error}
        rowKey={(s) => s.name}
        empty="No secrets"
        columns={[
          { key: 'n', label: 'Reference', render: (s) => <Mono>{`\${secret:${s.name}}`}</Mono> },
          { key: 'd', label: 'Description', render: (s) => <Text fz="sm">{s.description || '—'}</Text> },
          { key: 'u', label: 'Updated', render: (s) => <TimeAgo at={s.updatedAt} /> },
          {
            key: 'x',
            label: '',
            render: (s) => (
              <Button
                size="xs"
                variant="subtle"
                color="red"
                aria-label="Delete"
                onClick={() =>
                  modals.openConfirmModal({
                    title: `Delete ${s.name}?`,
                    children: <Text fz="sm">Actions and integrations referencing it will fail.</Text>,
                    labels: { confirm: 'Delete', cancel: 'Cancel' },
                    confirmProps: { color: 'red' },
                    onConfirm: async () => {
                      await api.deleteSecret(s.name);
                      void qc.invalidateQueries({ queryKey: ['secrets'] });
                    },
                  })
                }
              >
                <IconTrash size={16} />
              </Button>
            ),
          },
        ]}
      />
    </Stack>
  );
}

export function DelegationsAdmin() {
  return <DelegationsTable />;
}
