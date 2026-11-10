import { useState } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Code,
  CopyButton,
  Group,
  Modal,
  PasswordInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Tabs,
  TagsInput,
  Text,
  TextInput,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import {
  IconBuilding,
  IconCheck,
  IconCopy,
  IconGitBranch,
  IconKey,
  IconPlus,
  IconRefresh,
  IconRobot,
  IconSettings,
  IconShieldLock,
  IconTrash,
  IconUsers,
} from '@tabler/icons-react';
import type { ConfigSource, Member, Organization } from '@asterius/shared';
import { api, errorText } from '../lib/api';
import { useAuth } from '../lib/auth';
import { DataTable } from '../components/DataTable';
import { Mono, PageHeader, QueryView, TimeAgo } from '../components/ui';
import { slugify } from '../components/builder/shell';
import { MONO_INPUT } from '../components/builder/blocks';
import { BrandLogo } from '../components/Brand';
import { CodeBlock } from '../components/CodeEditor';

const SLUG = /^[a-z][a-z0-9_-]{0,63}$/;
const notifyError = (e: unknown) => notifications.show({ color: 'red', message: errorText(e) });

// ---------- create ----------

function CreateOrgForm({ onCreated }: { onCreated: (o: Organization) => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [touched, setTouched] = useState(false);
  const [domains, setDomains] = useState<string[]>([]);
  const create = useMutation({ mutationFn: () => api.createOrg({ name: name.trim(), slug, domains }), onSuccess: onCreated, onError: notifyError });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <Stack>
        <TextInput
          label="Name"
          placeholder="Acme Corp"
          withAsterisk
          value={name}
          onChange={(e) => {
            setName(e.currentTarget.value);
            if (!touched) setSlug(slugify(e.currentTarget.value));
          }}
          data-autofocus
        />
        <TextInput
          label="Identifier"
          description="Used in URLs, API calls and webhook addresses; cannot be changed later"
          withAsterisk
          value={slug}
          onChange={(e) => {
            setTouched(true);
            setSlug(e.currentTarget.value);
          }}
          error={slug && !SLUG.test(slug) ? 'lowercase letters, digits, - and _, starting with a letter' : undefined}
          styles={MONO_INPUT}
        />
        <TagsInput
          label="Email domains"
          description="Once verified (DNS record, in settings), people signing in with SSO from these domains join automatically"
          placeholder="acme.com"
          value={domains}
          onChange={setDomains}
        />
        <Group justify="flex-end">
          <Button type="submit" loading={create.isPending} disabled={!name.trim() || !SLUG.test(slug)}>
            Create organization
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

export function NewOrganization() {
  const { switchOrg } = useAuth();
  const meta = useQuery({ queryKey: ['meta'], queryFn: api.meta, staleTime: Infinity });
  const { isSuperadmin } = useAuth();
  const allowed = meta.data?.orgCreation !== 'superadmin' || isSuperadmin;
  return (
    <Stack maw={560}>
      <PageHeader title="New organization" description="A separate catalog, workflows, integrations, secrets and members. You become its admin." />
      {allowed ? (
        <Card>
          <CreateOrgForm
            onCreated={(o) => {
              switchOrg(o.slug, '/admin/organization');
            }}
          />
        </Card>
      ) : (
        <Alert color="gray">Organizations are created by the platform team: ask them for one.</Alert>
      )}
    </Stack>
  );
}

/**
 * Signed in, in no organization: the application is "create a new organization". Accounts join one only by creating
 * it, by invitation, or through an organization's SSO. Super-admins can also open an existing one.
 */
export function Welcome() {
  const { user, switchOrg, signOut } = useAuth();
  const meta = useQuery({ queryKey: ['meta'], queryFn: api.meta, staleTime: Infinity });
  const all = useQuery({ queryKey: ['orgs', 'all'], queryFn: api.allOrgs, enabled: !!user?.superadmin });
  const navigate = useNavigate();
  const canCreate = meta.data?.orgCreation !== 'superadmin' || !!user?.superadmin;
  const open = (slug: string) => {
    switchOrg(slug);
    void navigate('/');
  };
  return (
    <Stack align="center" justify="center" mih="100vh" p="md">
      <Stack maw={520} w="100%" gap="lg">
        <Stack gap={6} align="center">
          <BrandLogo size={48} />
          <Title order={3}>{canCreate ? 'Create a new organization' : `Welcome, ${user?.name.split(' ')[0]}`}</Title>
          <Text c="dimmed" ta="center" fz="sm">
            {canCreate
              ? 'Your own catalog, workflows, integrations and members. You become its admin.'
              : 'Organizations are created by the platform team: ask them for one.'}
          </Text>
        </Stack>
        {canCreate && (
          <Card>
            <CreateOrgForm onCreated={(o) => open(o.slug)} />
          </Card>
        )}
        <Text c="dimmed" ta="center" fz="xs">
          Joining your company instead? Sign in with its SSO, or ask an organization admin to add <b>{user?.email}</b>.
        </Text>
        {!!all.data?.length && (
          <Card>
            <Stack gap="xs">
              <Text fw={500} fz="sm">
                Open an organization (super-admin)
              </Text>
              {all.data.map((o) => (
                <Button key={o.id} variant="default" justify="space-between" rightSection={<Mono>{o.slug}</Mono>} onClick={() => open(o.slug)}>
                  {o.name}
                </Button>
              ))}
            </Stack>
          </Card>
        )}
        <Group justify="center">
          <Button variant="subtle" color="gray" onClick={() => void signOut()}>
            Sign out
          </Button>
        </Group>
      </Stack>
    </Stack>
  );
}

// ---------- settings of the current organization ----------

export function OrganizationSettings() {
  const org = useQuery({ queryKey: ['org'], queryFn: api.org });
  const [tab, setTab] = useState<string | null>('general');
  return (
    <Stack>
      <PageHeader
        title={org.data?.name ?? 'Organization'}
        description={org.data ? <Mono>{org.data.slug}</Mono> : undefined}
        refresh={org}
        crumbs={[{ label: 'Organization' }]}
      />
      <QueryView q={org}>
        {(o) => (
          <Tabs value={tab} onChange={setTab} keepMounted={false}>
            <Tabs.List mb="lg">
              <Tabs.Tab value="general" leftSection={<IconSettings size={16} />}>
                General
              </Tabs.Tab>
              <Tabs.Tab value="members" leftSection={<IconUsers size={16} />} rightSection={<Badge size="xs">{o.memberCount}</Badge>}>
                Members
              </Tabs.Tab>
              <Tabs.Tab value="sso" leftSection={<IconShieldLock size={16} />}>
                Single sign-on
              </Tabs.Tab>
              <Tabs.Tab value="config" leftSection={<IconGitBranch size={16} />}>
                Configuration as code
              </Tabs.Tab>
              <Tabs.Tab value="mcp" leftSection={<IconRobot size={16} />}>
                AI assistants (MCP)
              </Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="general">
              <GeneralTab org={o} />
            </Tabs.Panel>
            <Tabs.Panel value="members">
              <MembersTab />
            </Tabs.Panel>
            <Tabs.Panel value="sso">
              <SsoTab org={o} />
            </Tabs.Panel>
            <Tabs.Panel value="config">
              <ConfigTab org={o} />
            </Tabs.Panel>
            <Tabs.Panel value="mcp">
              <McpTab org={o} />
            </Tabs.Panel>
          </Tabs>
        )}
      </QueryView>
    </Stack>
  );
}

function GeneralTab({ org }: { org: Organization }) {
  const qc = useQueryClient();
  const { signOut, user, switchOrg } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState(org.name);
  const [domains, setDomains] = useState(org.domains);
  const save = useMutation({
    mutationFn: () => api.updateOrg({ name: name.trim(), domains }),
    onSuccess: (o) => {
      qc.setQueryData(['org'], o);
      void qc.invalidateQueries({ queryKey: ['me'] });
      notifications.show({ color: 'green', message: 'Organization saved' });
    },
    onError: notifyError,
  });
  const remove = () => {
    let typed = '';
    modals.openConfirmModal({
      title: `Delete ${org.name}?`,
      children: (
        <Stack gap="sm">
          <Text fz="sm">
            Its catalog, workflows, runs, integrations, webhooks, secrets and API tokens are deleted for good. Type <Code>{org.slug}</Code> to confirm.
          </Text>
          <TextInput onChange={(e) => (typed = e.currentTarget.value)} aria-label="Organization identifier" />
        </Stack>
      ),
      labels: { confirm: 'Delete organization', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await api.deleteOrg(typed);
          notifications.show({ message: `${org.name} deleted` });
          const next = user?.organizations?.find((o) => o.slug !== org.slug);
          if (next) switchOrg(next.slug);
          else void signOut();
          void navigate('/');
        } catch (e) {
          notifyError(e);
        }
      },
    });
  };
  return (
    <Stack maw={640}>
      {org.managed && (
        <Alert color="grape" variant="light">
          Declared in the platform configuration: name and domains are changed there.
        </Alert>
      )}
      <fieldset disabled={org.managed} style={{ border: 0, padding: 0, margin: 0 }}>
        <Stack>
          <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <TextInput label="Identifier" value={org.slug} disabled styles={MONO_INPUT} description="Fixed: it appears in webhook URLs and API calls" />
          <TagsInput
            label="Email domains"
            description="Once verified: people from these domains are routed to the organization's identity provider and join it"
            placeholder="acme.com"
            value={domains}
            onChange={setDomains}
          />
          <Group justify="flex-end">
            <Button onClick={() => save.mutate()} loading={save.isPending}>
              Save
            </Button>
          </Group>
        </Stack>
      </fieldset>
      {org.domainStatus.length > 0 && <DomainVerification org={org} />}
      <Card withBorder shadow="none" style={{ borderColor: 'var(--mantine-color-red-3)' }}>
        <Group justify="space-between" wrap="nowrap">
          <div>
            <Text fw={600}>Delete this organization</Text>
            <Text fz="sm" c="dimmed">
              Everything it holds is deleted. This cannot be undone.
            </Text>
          </div>
          <Button color="red" variant="light" onClick={remove} disabled={org.slug === 'default' || org.managed}>
            Delete
          </Button>
        </Group>
      </Card>
    </Stack>
  );
}

/** Domains count only once their DNS TXT record proves the organization controls them (anyone can type a domain). */
function DomainVerification({ org }: { org: Organization }) {
  const qc = useQueryClient();
  const { isSuperadmin } = useAuth();
  const verify = useMutation({
    mutationFn: (v: { domain: string; trusted?: boolean }) => api.verifyDomain(v.domain, !!v.trusted),
    onSuccess: (o, v) => {
      qc.setQueryData(['org'], o);
      notifications.show({ color: 'green', message: `${v.domain} verified` });
    },
    onError: notifyError,
  });
  return (
    <Card>
      <Stack gap="sm">
        <Text fw={600} fz="sm">
          Domain verification
        </Text>
        <Text fz="xs" c="dimmed">
          Publish this TXT record at your DNS provider, then verify. Until then, the domain neither routes sign-ins nor lets people join.
        </Text>
        {org.domainStatus.map((d) => (
          <Group key={d.domain} justify="space-between" wrap="nowrap" align="flex-start">
            <Stack gap={4} style={{ minWidth: 0 }}>
              <Group gap="xs">
                <Text fz="sm" fw={500}>
                  {d.domain}
                </Text>
                <Badge color={d.verified ? 'green' : 'yellow'} size="sm">
                  {d.verified ? 'verified' : 'pending'}
                </Badge>
              </Group>
              {!d.verified && (
                <Group gap={6} wrap="nowrap">
                  <Code fz="xs" style={{ overflowWrap: 'anywhere' }}>
                    {d.record} TXT &quot;{d.value}&quot;
                  </Code>
                  <CopyButton value={d.value}>
                    {({ copied, copy }) => (
                      <ActionIcon variant="subtle" size="sm" onClick={copy} aria-label="Copy the record value">
                        {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                      </ActionIcon>
                    )}
                  </CopyButton>
                </Group>
              )}
            </Stack>
            {!d.verified && (
              <Group gap="xs" wrap="nowrap">
                {isSuperadmin && (
                  <Button size="xs" variant="subtle" onClick={() => verify.mutate({ domain: d.domain, trusted: true })}>
                    Mark verified
                  </Button>
                )}
                <Button size="xs" variant="default" loading={verify.isPending} onClick={() => verify.mutate({ domain: d.domain })}>
                  Verify
                </Button>
              </Group>
            )}
          </Group>
        ))}
      </Stack>
    </Card>
  );
}

function MembersTab() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const members = useQuery({ queryKey: ['members'], queryFn: api.members });
  const sso = useQuery({ queryKey: ['sso'], queryFn: api.sso });
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['members'] });
    void qc.invalidateQueries({ queryKey: ['org'] });
  };
  const add = useMutation({
    mutationFn: () => api.addMember(email.trim(), role),
    onSuccess: (r) => {
      notifications.show({ color: 'green', message: r.status === 'invited' ? `Invitation sent to ${email}` : `${email} added` });
      setAdding(false);
      setEmail('');
      refresh();
    },
    onError: notifyError,
  });
  const act = (fn: () => Promise<unknown>, ok: string) =>
    fn().then(() => {
      notifications.show({ message: ok });
      refresh();
    }, notifyError);
  return (
    <Stack>
      <Group justify="space-between">
        <Text fz="sm" c="dimmed">
          Roles are per organization: admins manage its catalog, workflows, integrations, members and settings.
        </Text>
        <Button leftSection={<IconPlus size={16} />} onClick={() => setAdding(true)}>
          Add people
        </Button>
      </Group>
      <DataTable<Member>
        rows={members.data}
        loading={members.isPending}
        error={members.error}
        rowKey={(m) => m.id}
        empty="No members"
        columns={[
          {
            key: 'n',
            label: 'Name',
            render: (m) => (
              <div>
                <Text fz="sm" fw={500}>
                  {m.name}
                </Text>
                <Text fz="xs" c="dimmed">
                  {m.email}
                </Text>
              </div>
            ),
          },
          { key: 'p', label: 'Sign-in', render: (m) => <Badge color="gray">{m.provider === 'keycloak' ? 'SSO' : m.provider}</Badge> },
          {
            key: 'r',
            label: 'Role',
            render: (m) => (
              <Select
                size="xs"
                w={120}
                data={['admin', 'member']}
                value={m.role}
                allowDeselect={false}
                disabled={m.id === user?.id && !user?.superadmin}
                onChange={(r) => r && void act(() => api.setMemberRole(m.id, r as 'admin' | 'member'), `${m.name} is now ${r}`)}
                aria-label={`Role of ${m.name}`}
              />
            ),
          },
          {
            key: 'v',
            label: 'Joined',
            render: (m) => (
              <Text fz="sm">
                {m.via === 'sso' ? 'via SSO' : m.via === 'config' ? 'via configuration' : 'added'} · <TimeAgo at={m.joinedAt} />
              </Text>
            ),
          },
          { key: 'l', label: 'Last sign-in', render: (m) => <TimeAgo at={m.lastLoginAt} /> },
          {
            key: 'x',
            label: '',
            width: 60,
            render: (m) => (
              <Tooltip label="Remove from the organization">
                <ActionIcon
                  variant="subtle"
                  color="red"
                  aria-label={`Remove ${m.name}`}
                  onClick={() =>
                    modals.openConfirmModal({
                      title: `Remove ${m.name}?`,
                      children: <Text fz="sm">They lose access to this organization and its API tokens are revoked.</Text>,
                      labels: { confirm: 'Remove', cancel: 'Cancel' },
                      confirmProps: { color: 'red' },
                      onConfirm: () => void act(() => api.removeMember(m.id), `${m.name} removed`),
                    })
                  }
                >
                  <IconTrash size={16} />
                </ActionIcon>
              </Tooltip>
            ),
          },
        ]}
      />
      <Modal opened={adding} onClose={() => setAdding(false)} title={<Text fw={600}>Add people</Text>}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <Stack>
            <TextInput label="Email" type="email" withAsterisk value={email} onChange={(e) => setEmail(e.currentTarget.value)} data-autofocus />
            <SegmentedControl value={role} onChange={(v) => setRole(v as 'admin' | 'member')} data={['member', 'admin']} />
            <Text fz="xs" c="dimmed">
              {sso.data?.enabled
                ? 'People without an account receive an invitation email to register and join.'
                : 'They need an account already (they can sign up first). Enable single sign-on to send invitations.'}
            </Text>
            <Group justify="flex-end">
              <Button type="submit" loading={add.isPending} disabled={!email.includes('@')}>
                Add
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </Stack>
  );
}

function SsoTab({ org }: { org: Organization }) {
  const qc = useQueryClient();
  const sso = useQuery({ queryKey: ['sso'], queryFn: api.sso });
  const [adding, setAdding] = useState(false);
  const enable = useMutation({
    mutationFn: api.enableSso,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sso'] });
      void qc.invalidateQueries({ queryKey: ['org'] });
    },
    onError: notifyError,
  });
  return (
    <QueryView q={sso}>
      {(s) =>
        !s.available ? (
          <Alert color="gray" icon={<IconShieldLock size={18} />} title="Single sign-on is not set up on this platform" maw={720}>
            Organizations connect their own identity provider (Entra ID, Okta, Google, any OIDC or SAML) through Keycloak. Platform operators enable it with{' '}
            <Code>AUTH_PROVIDERS=keycloak</Code> and <Code>KEYCLOAK_URL</Code> (Helm: <Code>keycloak.enabled</Code>).
          </Alert>
        ) : !s.enabled ? (
          <Card maw={720}>
            <Stack>
              <Text fw={600}>Enable single sign-on</Text>
              <Text fz="sm" c="dimmed">
                Links {org.name} to an organization in the identity service: you can then connect your company&apos;s identity provider, route your email
                domains to it and invite people by email.
              </Text>
              <Group>
                <Button onClick={() => enable.mutate()} loading={enable.isPending} leftSection={<IconShieldLock size={16} />}>
                  Enable SSO
                </Button>
              </Group>
            </Stack>
          </Card>
        ) : (
          <Stack>
            <Group justify="space-between">
              <Text fz="sm" c="dimmed" maw={720}>
                People whose email domain matches a provider are sent to it at sign-in; members of the organization in the identity service join here
                automatically. {org.domains.length ? '' : 'Add your email domains in General.'}
              </Text>
              <Button leftSection={<IconPlus size={16} />} onClick={() => setAdding(true)}>
                Connect a provider
              </Button>
            </Group>
            <DataTable
              rows={s.providers}
              rowKey={(p) => p.alias}
              empty="No identity provider connected yet: members sign in with an email and password."
              columns={[
                {
                  key: 'n',
                  label: 'Provider',
                  render: (p) => (
                    <div>
                      <Text fz="sm" fw={500}>
                        {p.displayName}
                      </Text>
                      <Text fz="xs" c="dimmed" ff="monospace">
                        {p.alias}
                      </Text>
                    </div>
                  ),
                },
                { key: 't', label: 'Protocol', render: (p) => <Badge color="gray">{p.type.toUpperCase()}</Badge> },
                { key: 'd', label: 'Email domain', render: (p) => (p.domain ? <Mono>{p.domain}</Mono> : '—') },
                {
                  key: 'u',
                  label: 'Issuer / metadata',
                  render: (p) => (
                    <Text fz="xs" truncate maw={280}>
                      {p.url ?? '—'}
                    </Text>
                  ),
                },
                {
                  key: 'x',
                  label: '',
                  width: 60,
                  render: (p) => (
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      aria-label={`Disconnect ${p.displayName}`}
                      onClick={() =>
                        modals.openConfirmModal({
                          title: `Disconnect ${p.displayName}?`,
                          children: <Text fz="sm">People who signed in through it can no longer do so.</Text>,
                          labels: { confirm: 'Disconnect', cancel: 'Cancel' },
                          confirmProps: { color: 'red' },
                          onConfirm: () => void api.removeSsoProvider(p.alias).then(() => void qc.invalidateQueries({ queryKey: ['sso'] }), notifyError),
                        })
                      }
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  ),
                },
              ]}
            />
            <AddProviderModal opened={adding} domains={org.domains} onClose={() => setAdding(false)} />
          </Stack>
        )
      }
    </QueryView>
  );
}

function AddProviderModal({ opened, onClose, domains }: { opened: boolean; onClose: () => void; domains: string[] }) {
  const qc = useQueryClient();
  const [type, setType] = useState<'oidc' | 'saml'>('oidc');
  const [displayName, setDisplayName] = useState('');
  const [alias, setAlias] = useState('');
  const [url, setUrl] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [domain, setDomain] = useState<string | null>(domains[0] ?? null);
  const add = useMutation({
    mutationFn: () => api.addSsoProvider({ type, displayName, alias, url, clientId, clientSecret, domain }),
    onSuccess: () => {
      notifications.show({ color: 'green', message: `${displayName || alias} connected` });
      void qc.invalidateQueries({ queryKey: ['sso'] });
      onClose();
    },
    onError: notifyError,
  });
  return (
    <Modal opened={opened} onClose={onClose} title={<Text fw={600}>Connect an identity provider</Text>} size="lg">
      <Stack>
        <SegmentedControl
          value={type}
          onChange={(v) => setType(v as 'oidc' | 'saml')}
          data={[
            { value: 'oidc', label: 'OpenID Connect (Entra ID, Okta, Google…)' },
            { value: 'saml', label: 'SAML 2.0' },
          ]}
        />
        <SimpleGrid cols={2}>
          <TextInput
            label="Name"
            placeholder="Acme Entra ID"
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.currentTarget.value);
              setAlias(slugify(e.currentTarget.value).slice(0, 40));
            }}
          />
          <TextInput label="Alias" value={alias} onChange={(e) => setAlias(e.currentTarget.value)} styles={MONO_INPUT} withAsterisk />
        </SimpleGrid>
        <TextInput
          label={type === 'oidc' ? 'Issuer or discovery URL' : 'Metadata URL'}
          placeholder={type === 'oidc' ? 'https://login.microsoftonline.com/<tenant-id>/v2.0' : 'https://idp.example.com/metadata.xml'}
          withAsterisk
          value={url}
          onChange={(e) => setUrl(e.currentTarget.value)}
        />
        {type === 'oidc' && (
          <SimpleGrid cols={2}>
            <TextInput label="Client ID" withAsterisk value={clientId} onChange={(e) => setClientId(e.currentTarget.value)} />
            <PasswordInput label="Client secret" withAsterisk value={clientSecret} onChange={(e) => setClientSecret(e.currentTarget.value)} />
          </SimpleGrid>
        )}
        <Select
          label="Email domain routed to it"
          description="Domains come from the General tab"
          data={domains}
          value={domain}
          onChange={setDomain}
          clearable
          placeholder={domains.length ? 'None' : 'Add a domain in General first'}
        />
        <Alert color="gray" variant="light">
          <Text fz="xs">
            In the provider, register an application whose redirect URI is the broker endpoint of the identity service:{' '}
            <Code>{`<keycloak>/realms/<realm>/broker/<org>-${alias || '<alias>'}/endpoint`}</Code>. Your platform team can give you the exact host.
          </Text>
        </Alert>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => add.mutate()} loading={add.isPending} disabled={!alias || !url || (type === 'oidc' && (!clientId || !clientSecret))}>
            Connect
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function ConfigTab({ org }: { org: Organization }) {
  const qc = useQueryClient();
  const { isSuperadmin } = useAuth();
  const src = org.configSource;
  const [type, setType] = useState<ConfigSource['type']>(src.type);
  const [url, setUrl] = useState(src.type === 'git' ? src.url : '');
  const [branch, setBranch] = useState(src.type === 'git' ? src.branch : 'main');
  const [path, setPath] = useState(src.type === 'git' ? src.path : '');
  const [token, setToken] = useState(src.type === 'git' ? (src.token ?? '') : '');
  const secrets = useQuery({ queryKey: ['secrets'], queryFn: api.secrets, staleTime: 30_000 });
  const done = (o: Organization) => {
    qc.setQueryData(['org'], o);
    notifications.show({ color: o.configStatus?.ok === false ? 'yellow' : 'green', message: o.configStatus?.error ?? 'Configuration source saved' });
  };
  const save = useMutation({
    mutationFn: () => api.setConfigSource(type === 'git' ? { type, url, branch, path, token: token || null } : ({ type } as ConfigSource)),
    onSuccess: done,
    onError: notifyError,
  });
  const sync = useMutation({ mutationFn: api.syncConfig, onSuccess: done, onError: notifyError });
  const st = org.configStatus;
  const directoryOk = org.slug === 'default' || org.managed || isSuperadmin;
  return (
    <Stack maw={760}>
      <Text fz="sm" c="dimmed">
        Blueprints, actions, integrations, webhooks and teams declared in YAML files are applied to this organization and become read-only in the UI (changes go
        through Git reviews). Resources created in the UI live alongside them. Export what exists today from Configuration.
      </Text>
      <SegmentedControl
        value={type}
        onChange={(v) => setType(v as ConfigSource['type'])}
        data={[
          { value: 'none', label: 'UI only' },
          { value: 'git', label: 'Git repository' },
          { value: 'directory', label: 'Mounted directory', disabled: !directoryOk },
        ]}
      />
      {type === 'git' && (
        <Card>
          <Stack>
            <TextInput
              label="Repository (https)"
              placeholder="https://github.com/acme/platform-config.git"
              withAsterisk
              value={url}
              onChange={(e) => setUrl(e.currentTarget.value)}
            />
            <SimpleGrid cols={2}>
              <TextInput label="Branch" value={branch} onChange={(e) => setBranch(e.currentTarget.value)} styles={MONO_INPUT} />
              <TextInput label="Folder" placeholder="platform/" value={path} onChange={(e) => setPath(e.currentTarget.value)} styles={MONO_INPUT} />
            </SimpleGrid>
            <Select
              label="Access token"
              description="A secret of this organization (Admin → Secrets) holding a read-only token. Empty for public repositories."
              clearable
              data={(secrets.data ?? []).map((s) => `\${secret:${s.name}}`)}
              value={token || null}
              onChange={(v) => setToken(v ?? '')}
              leftSection={<IconKey size={16} />}
              styles={MONO_INPUT}
            />
          </Stack>
        </Card>
      )}
      {type === 'directory' && (
        <Alert color="gray" variant="light">
          Files are read from <Code>{org.slug === 'default' ? 'CONFIG_DIR' : `CONFIG_DIR/orgs/${org.slug}`}</Code> on the platform (a ConfigMap or a git-sync
          volume set up by the platform operators).
        </Alert>
      )}
      <Group justify="space-between">
        {st ? (
          <Group gap="xs">
            <Badge color={st.ok ? 'green' : 'red'} leftSection={st.ok ? <IconCheck size={14} /> : undefined}>
              {st.ok ? 'in sync' : 'failed'}
            </Badge>
            <Text fz="sm" c="dimmed">
              {st.files} file(s){st.revision ? ` · ${st.revision}` : ''} · checked <TimeAgo at={st.at} />
            </Text>
          </Group>
        ) : (
          <span />
        )}
        <Group gap="xs">
          {src.type !== 'none' && (
            <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={() => sync.mutate()} loading={sync.isPending}>
              Sync now
            </Button>
          )}
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={type === 'git' && !url.startsWith('https://')}>
            Save
          </Button>
        </Group>
      </Group>
      {st?.error && (
        <Alert color="red" variant="light" title="Last sync failed">
          <Text fz="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {st.error}
          </Text>
        </Alert>
      )}
    </Stack>
  );
}

function McpTab({ org }: { org: Organization }) {
  const endpoint = `${window.location.origin}/api/mcp`;
  const command = `claude mcp add --transport http ${org.slug} ${endpoint} --header "Authorization: Bearer <API token>"`;
  const json = JSON.stringify({ mcpServers: { [org.slug]: { type: 'http', url: endpoint, headers: { Authorization: 'Bearer <API token>' } } } }, null, 2);
  // Claude Desktop only accepts stdio servers: bridge to the HTTP endpoint with mcp-remote.
  // No space after "Authorization:" — the value comes from env so the arg has no spaces.
  const desktopJson = JSON.stringify(
    {
      mcpServers: {
        [org.slug]: {
          command: 'npx',
          args: ['-y', 'mcp-remote', endpoint, '--header', 'Authorization:${AUTH_HEADER}'],
          env: { AUTH_HEADER: 'Bearer <API token>' },
        },
      },
    },
    null,
    2,
  );
  const copy = (v: string) => (
    <CopyButton value={v}>
      {({ copied, copy: c }) => (
        <ActionIcon variant="subtle" onClick={c} aria-label="Copy">
          {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
        </ActionIcon>
      )}
    </CopyButton>
  );
  return (
    <Stack maw={820}>
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <ThemeIcon size={36}>
          <IconRobot size={18} />
        </ThemeIcon>
        <Text fz="sm" c="dimmed">
          AI assistants (Claude, IDE agents) connect over the Model Context Protocol to search the catalog, read entities, start self-service actions and follow
          runs, with the permissions of the token&apos;s owner in {org.name}. Approving requests stays with people.
        </Text>
      </Group>
      <Card>
        <Stack gap="sm">
          <Text fw={600} fz="sm">
            1. Create an API token in this organization
          </Text>
          <Text fz="sm" c="dimmed">
            Tokens act in the organization they were created in.{' '}
            <Anchor component={Link} to="/profile">
              Profile → API tokens
            </Anchor>{' '}
            (personal) or{' '}
            <Anchor component={Link} to="/admin/users">
              a service account
            </Anchor>{' '}
            (shared agents).
          </Text>
          <Text fw={600} fz="sm" mt="xs">
            2. Add the server
          </Text>
          <Group gap="xs" wrap="nowrap">
            <Code block style={{ flex: 1, overflowX: 'auto' }}>
              {command}
            </Code>
            {copy(command)}
          </Group>
          <Text fz="xs" c="dimmed">
            Or in an MCP client configuration that supports HTTP servers (Cursor, VS Code):
          </Text>
          <Group gap="xs" wrap="nowrap" align="flex-start">
            <div style={{ flex: 1, minWidth: 0 }}>
              <CodeBlock code={json} />
            </div>
            {copy(json)}
          </Group>
          <Text fz="xs" c="dimmed">
            Claude Desktop (<Code fz="xs">claude_desktop_config.json</Code>) only runs local servers, so bridge with <Code fz="xs">mcp-remote</Code> (requires
            Node 18+), then restart Claude Desktop:
          </Text>
          <Group gap="xs" wrap="nowrap" align="flex-start">
            <div style={{ flex: 1, minWidth: 0 }}>
              <CodeBlock code={desktopJson} />
            </div>
            {copy(desktopJson)}
          </Group>
        </Stack>
      </Card>
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        {[
          ['Catalog', 'list_blueprints · search_catalog · get_entity'],
          ['Self-service', 'list_actions · run_action'],
          ['Runs', 'get_run · list_runs · list_approvals'],
        ].map(([t, d]) => (
          <Card key={t} padding="md">
            <Text fw={600} fz="sm">
              {t}
            </Text>
            <Text fz="xs" c="dimmed" ff="monospace">
              {d}
            </Text>
          </Card>
        ))}
      </SimpleGrid>
    </Stack>
  );
}

// ---------- platform (super-admins) ----------

export function PlatformOrganizations() {
  const qc = useQueryClient();
  const { switchOrg } = useAuth();
  const navigate = useNavigate();
  const orgs = useQuery({ queryKey: ['all-orgs'], queryFn: api.allOrgs });
  return (
    <Stack>
      <PageHeader
        title="Organizations"
        description="Every tenant of the platform. Open one to work in it as a super-admin."
        refresh={orgs}
        actions={
          <Button component={Link} to="/orgs/new" leftSection={<IconPlus size={16} />}>
            New organization
          </Button>
        }
      />
      <DataTable<Organization>
        rows={orgs.data}
        loading={orgs.isPending}
        error={orgs.error}
        rowKey={(o) => o.id}
        onRowClick={(o) => {
          switchOrg(o.slug);
          void navigate('/');
        }}
        columns={[
          {
            key: 'n',
            label: 'Organization',
            render: (o) => (
              <Group gap="sm" wrap="nowrap">
                <ThemeIcon variant="light" size={30}>
                  <IconBuilding size={16} />
                </ThemeIcon>
                <div>
                  <Text fz="sm" fw={500}>
                    {o.name}
                  </Text>
                  <Text fz="xs" c="dimmed" ff="monospace">
                    {o.slug}
                  </Text>
                </div>
                {o.managed && (
                  <Badge color="grape" variant="outline" size="sm">
                    config
                  </Badge>
                )}
              </Group>
            ),
          },
          { key: 'm', label: 'Members', render: (o) => o.memberCount },
          { key: 'd', label: 'Domains', render: (o) => o.domains.join(', ') || '—' },
          { key: 's', label: 'SSO', render: (o) => (o.sso.enabled ? <Badge color="green">enabled</Badge> : '—') },
          {
            key: 'c',
            label: 'Configuration',
            render: (o) => (o.configSource.type === 'none' ? '—' : <Badge color={o.configStatus?.ok === false ? 'red' : 'gray'}>{o.configSource.type}</Badge>),
          },
          { key: 't', label: 'Created', render: (o) => <TimeAgo at={o.createdAt} /> },
          {
            key: 'x',
            label: '',
            width: 60,
            render: (o) =>
              o.slug === 'default' ? null : (
                <ActionIcon
                  variant="subtle"
                  color="red"
                  aria-label={`Delete ${o.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    modals.openConfirmModal({
                      title: `Delete ${o.name}?`,
                      children: <Text fz="sm">Everything the organization holds is deleted for good.</Text>,
                      labels: { confirm: 'Delete', cancel: 'Cancel' },
                      confirmProps: { color: 'red' },
                      onConfirm: () => void api.deleteOrgById(o.id).then(() => void qc.invalidateQueries({ queryKey: ['all-orgs'] }), notifyError),
                    });
                  }}
                >
                  <IconTrash size={16} />
                </ActionIcon>
              ),
          },
        ]}
      />
    </Stack>
  );
}
