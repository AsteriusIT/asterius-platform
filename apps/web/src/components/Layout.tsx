import { useEffect, useState } from 'react';
import {
  ActionIcon,
  AppShell,
  Avatar,
  Badge,
  Box,
  Burger,
  Group,
  Indicator,
  Kbd,
  Menu,
  NavLink,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
  useMantineColorScheme,
} from '@mantine/core';
import { useDisclosure, useHotkeys, useLocalStorage, useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import {
  IconActivity,
  IconBolt,
  IconCategory2,
  IconChecklist,
  IconDots,
  IconBell,
  IconHistory,
  IconLayoutDashboard,
  IconMedal,
  IconTrashX,
  IconHome,
  IconKey,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconLock,
  IconLogout,
  IconMoon,
  IconPlugConnected,
  IconRobot,
  IconRefresh,
  IconRocket,
  IconSend,
  IconSchema,
  IconSearch,
  IconSettingsAutomation,
  IconSun,
  IconUser,
  IconHelpCircle,
  IconUsersGroup,
  IconBuilding,
  IconBuildingCommunity,
  IconCheck,
  IconPlus,
  IconSelector,
  IconShieldLock,
  IconWebhook,
  IconShieldCheck,
} from '@tabler/icons-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Tour } from './Tour';
import { tourSteps } from './tourSteps';
import { useT } from '../lib/i18n';
import { CommandPalette } from './CommandPalette';
import { NotificationCenter } from './NotificationCenter';
import { BrandLogo, BrandMark } from './Brand';

const initials = (name = '') =>
  name
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

/**
 * LibreChat-like shell: soft sidebar (brand, navigation, account at the bottom), white canvas, slim header. On desktop the
 * sidebar folds to icons only (remembered per browser; Ctrl/⌘+B); on mobile it is a drawer.
 */
export function Layout() {
  const [opened, { toggle, open, close }] = useDisclosure();
  const [touring, setTouring] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const t = useT();
  const isMobile = useMediaQuery('(max-width: 48em)');
  const qc = useQueryClient();
  const { user, isAdmin, isSuperadmin, org, signOut, switchOrg } = useAuth();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const location = useLocation();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const refreshAll = () => {
    setRefreshing(true);
    void qc.refetchQueries({ type: 'active' }).finally(() => setRefreshing(false));
  };
  const blueprints = useQuery({ queryKey: ['blueprints'], queryFn: api.blueprints, staleTime: 30_000 });
  const meta = useQuery({ queryKey: ['meta'], queryFn: api.meta, staleTime: Infinity });
  const entityTotal = blueprints.data?.reduce((n, b) => n + (b.entityCount ?? 0), 0);
  const [collapsed, setCollapsed] = useLocalStorage({ key: 'asterius.nav-collapsed', defaultValue: false, getInitialValueInEffect: false });
  const mini = collapsed && !isMobile;
  const toggleMini = () => setCollapsed((c) => !c);
  useHotkeys([['mod+B', toggleMini]]);
  const approvals = useQuery({ queryKey: ['approvals'], queryFn: api.approvals, refetchInterval: 30_000 });

  const active = (to: string) => (to === '/' ? location.pathname === '/' : location.pathname === to || location.pathname.startsWith(`${to}/`));
  const link = (to: string, label: string, icon: React.ReactNode, right?: React.ReactNode, tour?: string) => (
    <Tooltip key={to} label={label} position="right" disabled={!mini} openDelay={0}>
      <NavLink
        data-tour={tour}
        className="nav-link"
        component={Link}
        to={to}
        label={mini ? undefined : label}
        aria-label={label}
        leftSection={icon}
        rightSection={mini ? undefined : right}
        active={active(to)}
        onClick={close}
      />
    </Tooltip>
  );
  // Folded sidebar: section titles become a thin separator.
  const section = (label: string) => (mini ? <div className="nav-section-rule" aria-hidden /> : <div className="nav-section">{label}</div>);

  // Onboarding: start the tour on a user's first visit (completion is stored server-side, across devices).
  useEffect(() => {
    if (!user || user.tourCompletedAt) return;
    const t = setTimeout(() => setTouring(true), 700);
    return () => clearTimeout(t);
  }, [user]);
  const startTour = () => {
    if (isMobile) open(); // the navigation lives in the drawer on small screens
    setTouring(true);
  };
  useEffect(() => {
    if (touring && isMobile) open();
  }, [touring, isMobile, open]);
  const endTour = (completed: boolean) => {
    setTouring(false);
    if (isMobile) close();
    void api.setTourCompleted(true).then((u) => qc.setQueriesData({ queryKey: ['me'] }, u));
    if (completed) void navigate('/self-service');
  };

  return (
    <AppShell layout="alt" header={{ height: 60 }} navbar={{ width: mini ? 68 : 264, breakpoint: 'sm', collapsed: { mobile: !opened } }} padding={0}>
      <a
        href="#main-content"
        style={{ position: 'absolute', left: -9999, top: 0, zIndex: 1000, background: 'var(--mantine-color-body)', padding: 8 }}
        onFocus={(e) => (e.currentTarget.style.left = '8px')}
        onBlur={(e) => (e.currentTarget.style.left = '-9999px')}
      >
        {t('app.skipToContent')}
      </a>
      <CommandPalette isAdmin={isAdmin} opened={paletteOpen} onOpenChange={setPaletteOpen} />
      <AppShell.Header className="app-header">
        <Group h="100%" px="lg" justify="space-between" wrap="nowrap" gap="md">
          <Group gap="sm" wrap="nowrap">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <UnstyledButton component={Link} to="/" hiddenFrom="sm" aria-label="Home">
              <BrandLogo size={26} />
            </UnstyledButton>
          </Group>
          <form
            className="header-search"
            data-tour="search"
            style={{ flex: 1, maxWidth: 520 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (search.trim()) void navigate(`/search?q=${encodeURIComponent(search.trim())}`);
            }}
          >
            <TextInput
              radius="xl"
              placeholder="Search the catalog"
              leftSection={<IconSearch size={16} />}
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              aria-label="Search the catalog"
              rightSection={<Kbd size="xs">Ctrl K</Kbd>}
              rightSectionWidth={64}
            />
          </form>
          <Group gap={4} wrap="nowrap">
            <Tooltip label={approvals.data?.length ? `Approvals · ${approvals.data.length} waiting for you` : 'Approvals'}>
              <Indicator label={approvals.data?.length} size={16} color="yellow" offset={5} disabled={!approvals.data?.length} inline>
                <ActionIcon
                  component={Link}
                  to="/approvals"
                  data-tour="approvals"
                  variant={active('/approvals') ? 'light' : 'subtle'}
                  color="gray"
                  size="lg"
                  aria-label={`Approvals${approvals.data?.length ? ` (${approvals.data.length} waiting)` : ''}`}
                >
                  <IconChecklist size={19} stroke={1.6} />
                </ActionIcon>
              </Indicator>
            </Tooltip>
            <NotificationCenter />
            <Tooltip label="Runs">
              <ActionIcon component={Link} to="/runs" data-tour="runs" variant={active('/runs') ? 'light' : 'subtle'} color="gray" size="lg" aria-label="Runs">
                <IconActivity size={19} stroke={1.6} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Refresh data">
              <ActionIcon variant="subtle" color="gray" size="lg" onClick={refreshAll} aria-label="Refresh data" aria-busy={refreshing}>
                <IconRefresh size={19} stroke={1.6} className={refreshing ? 'spin' : undefined} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={colorScheme === 'dark' ? 'Light theme' : 'Dark theme'}>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="lg"
                onClick={() => setColorScheme(colorScheme === 'dark' ? 'light' : 'dark')}
                aria-label="Toggle color scheme"
              >
                {colorScheme === 'dark' ? <IconSun size={19} stroke={1.6} /> : <IconMoon size={19} stroke={1.6} />}
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar className="app-navbar" p="sm" data-mini={mini || undefined}>
        <AppShell.Section visibleFrom="sm">
          {mini ? (
            <Stack gap={6} align="center">
              <UnstyledButton component={Link} to="/" py={6} aria-label="Home">
                <BrandLogo size={28} />
              </UnstyledButton>
              <Tooltip label="Expand sidebar (Ctrl/⌘+B)" position="right">
                <ActionIcon variant="subtle" color="gray" size="lg" onClick={toggleMini} aria-label="Expand sidebar">
                  <IconLayoutSidebarLeftExpand size={19} stroke={1.6} />
                </ActionIcon>
              </Tooltip>
            </Stack>
          ) : (
            <Group justify="space-between" wrap="nowrap" gap={4}>
              <UnstyledButton component={Link} to="/" onClick={close} px={10} py={6} display="block" aria-label="Home" style={{ minWidth: 0 }}>
                <BrandMark />
              </UnstyledButton>
              <Tooltip label="Collapse sidebar (Ctrl/⌘+B)">
                <ActionIcon variant="subtle" color="gray" size="lg" onClick={toggleMini} aria-label="Collapse sidebar">
                  <IconLayoutSidebarLeftCollapse size={19} stroke={1.6} />
                </ActionIcon>
              </Tooltip>
            </Group>
          )}
        </AppShell.Section>

        {/* Organization switcher: the tenant every page works in. */}
        <AppShell.Section mt="sm">
          <Menu position={mini ? 'right-start' : 'bottom-start'} width={260}>
            <Menu.Target>
              <Tooltip label={org?.name ?? 'Organization'} position="right" disabled={!mini}>
                <UnstyledButton className="nav-link org-switcher" w="100%" display="block" aria-label={`Organization: ${org?.name ?? 'none'}`} data-tour="org">
                  <Group gap={10} wrap="nowrap" justify={mini ? 'center' : undefined}>
                    <Avatar radius="md" size={26} color="brand" variant="filled">
                      {initials(org?.name)}
                    </Avatar>
                    {!mini && (
                      <>
                        <Box style={{ flex: 1, minWidth: 0 }}>
                          <Text fz={13.5} fw={600} truncate>
                            {org?.name}
                          </Text>
                          <Text fz={11.5} c="var(--text-3)" truncate>
                            {isAdmin ? 'Admin' : 'Member'}
                            {user?.organizations && user.organizations.length > 1 ? ` · ${user.organizations.length} organizations` : ''}
                          </Text>
                        </Box>
                        <IconSelector size={15} color="var(--text-3)" />
                      </>
                    )}
                  </Group>
                </UnstyledButton>
              </Tooltip>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>Organizations</Menu.Label>
              {user?.organizations?.map((o) => (
                <Menu.Item
                  key={o.id}
                  leftSection={
                    <Avatar radius="sm" size={20} color="brand" variant={o.slug === org?.slug ? 'filled' : 'light'} fz={10}>
                      {initials(o.name)}
                    </Avatar>
                  }
                  rightSection={o.slug === org?.slug ? <IconCheck size={14} /> : undefined}
                  onClick={() => {
                    if (o.slug === org?.slug) return;
                    close();
                    switchOrg(o.slug);
                    void navigate('/');
                  }}
                >
                  {o.name}
                </Menu.Item>
              ))}
              {org && !user?.organizations?.some((o) => o.slug === org.slug) && (
                <Menu.Item leftSection={<IconBuilding size={16} />} rightSection={<IconCheck size={14} />} disabled>
                  {org.name} (super-admin)
                </Menu.Item>
              )}
              <Menu.Divider />
              {isAdmin && (
                <Menu.Item component={Link} to="/admin/organization" leftSection={<IconBuilding size={16} />} onClick={close}>
                  Organization settings
                </Menu.Item>
              )}
              <Menu.Item component={Link} to="/orgs/new" leftSection={<IconPlus size={16} />} onClick={close}>
                New organization
              </Menu.Item>
              {isSuperadmin && (
                <Menu.Item component={Link} to="/platform/organizations" leftSection={<IconBuildingCommunity size={16} />} onClick={close}>
                  All organizations
                </Menu.Item>
              )}
            </Menu.Dropdown>
          </Menu>
        </AppShell.Section>

        <AppShell.Section grow component={ScrollArea} mt={4} mx={-4} px={4}>
          {link('/', 'Home', <IconHome size={18} stroke={1.6} />)}
          {link('/self-service', 'Self-service', <IconRocket size={18} stroke={1.6} />, undefined, 'self-service')}

          {link(
            '/catalog',
            'Catalog',
            <IconCategory2 size={18} stroke={1.6} />,
            entityTotal !== undefined ? (
              <Text fz="xs" c="var(--text-3)">
                {entityTotal}
              </Text>
            ) : undefined,
            'catalog',
          )}

          {isAdmin && (
            <div data-tour="admin">
              {section('Administration')}
              {link('/admin/blueprints', 'Blueprints', <IconSchema size={18} stroke={1.6} />)}
              {link('/admin/actions', 'Actions', <IconBolt size={18} stroke={1.6} />)}
              {link('/admin/integrations', 'Integrations', <IconPlugConnected size={18} stroke={1.6} />)}
              {link('/admin/dashboards', 'Dashboards', <IconLayoutDashboard size={18} stroke={1.6} />)}
              {link('/admin/scorecards', 'Scorecards', <IconMedal size={18} stroke={1.6} />)}
              {link('/admin/policies', 'Policies', <IconShieldCheck size={18} stroke={1.6} />)}
              {link('/admin/webhooks', 'Webhooks', <IconWebhook size={18} stroke={1.6} />)}
              {link('/admin/deliveries', 'Deliveries', <IconSend size={18} stroke={1.6} />)}
              {link('/admin/teams', 'Teams', <IconUsersGroup size={18} stroke={1.6} />)}
              {link('/admin/users', 'Users & service accounts', <IconKey size={18} stroke={1.6} />)}
              {link('/admin/secrets', 'Secrets', <IconLock size={18} stroke={1.6} />)}
              {link('/admin/deleted', 'Deleted entities', <IconTrashX size={18} stroke={1.6} />)}
              {link('/admin/notifications', 'Notifications', <IconBell size={18} stroke={1.6} />)}
              {link('/admin/audit', 'Audit log', <IconHistory size={18} stroke={1.6} />)}
              {link('/admin/ai', 'AI usage', <IconRobot size={18} stroke={1.6} />)}
              {link('/admin/config', 'Configuration', <IconSettingsAutomation size={18} stroke={1.6} />)}
              {link('/admin/organization', 'Organization', <IconBuilding size={18} stroke={1.6} />)}
            </div>
          )}
          {isSuperadmin && (
            <div>
              {section('Platform')}
              {link('/platform/organizations', 'All organizations', <IconBuildingCommunity size={18} stroke={1.6} />)}
            </div>
          )}
        </AppShell.Section>

        <AppShell.Section pt="xs" style={{ borderTop: '1px solid var(--hairline)' }}>
          <Menu position="top-start" width={248}>
            <Menu.Target>
              <UnstyledButton className="nav-link" w="100%" display="block" aria-label="Account" data-tour="account">
                <Group gap={10} wrap="nowrap" justify={mini ? 'center' : undefined}>
                  <Avatar radius="xl" size={30} variant="light">
                    {initials(user?.name)}
                  </Avatar>
                  {!mini && (
                    <Box style={{ flex: 1, minWidth: 0 }}>
                      <Text fz={14} fw={500} truncate>
                        {user?.name}
                      </Text>
                      <Text fz={12} c="var(--text-3)" truncate>
                        {user?.email}
                      </Text>
                    </Box>
                  )}
                  {!mini && <IconDots size={16} color="var(--text-3)" />}
                </Group>
              </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>
                <Group gap={4}>
                  <Badge size="sm" color={isAdmin ? 'brand' : 'gray'}>
                    {user?.role}
                  </Badge>
                  {user?.teams.map((t) => (
                    <Badge key={t.identifier} size="sm" color="gray">
                      {t.title}
                    </Badge>
                  ))}
                </Group>
              </Menu.Label>
              <Menu.Item component={Link} to="/profile" leftSection={<IconUser size={16} />} onClick={close}>
                Profile & API tokens
              </Menu.Item>
              {meta.data?.accountUrl && user?.provider === 'keycloak' && (
                <Menu.Item component="a" href={meta.data.accountUrl} target="_blank" rel="noreferrer" leftSection={<IconShieldLock size={16} />}>
                  Password, MFA & linked accounts
                </Menu.Item>
              )}
              <Menu.Item leftSection={<IconHelpCircle size={16} />} onClick={startTour}>
                Take the tour
              </Menu.Item>
              <Menu.Item leftSection={<IconLogout size={16} />} onClick={() => void signOut()}>
                Sign out
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main className="app-main" id="main-content" tabIndex={-1}>
        <div className="app-panel">
          <div className="app-content">
            <Outlet />
          </div>
        </div>
      </AppShell.Main>
      <Tour steps={tourSteps({ name: user?.name.split(' ')[0] ?? '', isAdmin })} opened={touring} onClose={endTour} />
    </AppShell>
  );
}
