import { useEffect, useState } from 'react';
import {
  ActionIcon,
  AppShell,
  Avatar,
  Badge,
  Burger,
  Group,
  Kbd,
  Menu,
  ScrollArea,
  Stack,
  TextInput,
  Tooltip,
  UnstyledButton,
  useMantineColorScheme,
} from '@mantine/core';
import { useDisclosure, useHotkeys, useLocalStorage, useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { tabIsActive, visibleCategories } from './adminSections';
import { RoleBadges } from './RoleBadges';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import {
  IconActivity,
  IconCategory2,
  IconChecklist,
  IconDots,
  IconHome,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconLogout,
  IconMoon,
  IconRefresh,
  IconRocket,
  IconSearch,
  IconSun,
  IconUser,
  IconHelpCircle,
  IconBuilding,
  IconBuildingCommunity,
  IconCheck,
  IconPlus,
  IconSelector,
  IconShieldLock,
  IconX,
} from '@tabler/icons-react';
import { api } from '../lib/api';
import { useAuth, useCan } from '../lib/auth';
import { Tour } from './Tour';
import { tourSteps } from './tourSteps';
import { useT } from '../lib/i18n';
import { CommandPalette } from './CommandPalette';
import { NotificationCenter } from './NotificationCenter';
import { BrandLogo, BrandMark } from './Brand';
import { initials } from './UserChip';
import { NavItem } from './NavItem';
import { ICON } from '@asterius/brand';

/**
 * LibreChat-like shell: soft sidebar (brand, navigation, account at the bottom), white canvas, slim header. On desktop the
 * sidebar folds to icons only (remembered per browser; Ctrl/⌘+B); on mobile it is a drawer.
 */
/** Pages drawn as a full-panel graph. */
const FLOW_VIEW = /^\/(runs|admin\/actions)\/[^/]+(\/flow)?$/;

export function Layout() {
  const [opened, { toggle, open, close }] = useDisclosure();
  const [touring, setTouring] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const t = useT();
  const isMobile = useMediaQuery('(max-width: 48em)');
  const qc = useQueryClient();
  const { user, isAdmin, isSuperadmin, org, signOut, switchOrg } = useAuth();
  const can = useCan();
  // Administration: the categories with at least one tab the user may open (admins: all; delegated roles: theirs).
  const adminCategories = visibleCategories(can);
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
  useHotkeys([
    ['mod+B', toggleMini],
    ['Escape', close], // the navigation drawer of a phone
  ]);
  const approvals = useQuery({ queryKey: ['approvals'], queryFn: api.approvals, refetchInterval: 30_000 });
  const todoCount = approvals.data?.length ?? 0;

  const active = (to: string) => (to === '/' ? location.pathname === '/' : location.pathname === to || location.pathname.startsWith(`${to}/`));
  /** What every route entry of the sidebar shares. */
  const item = (to: string) => ({ to, mini, active: active(to), onClick: close });
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
      <a href="#main-content" className="skip-link">
        {t('app.skipToContent')}
      </a>
      <CommandPalette can={can} opened={paletteOpen} onOpenChange={setPaletteOpen} />
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
            onSubmit={(e) => {
              e.preventDefault();
              if (search.trim()) void navigate(`/search?q=${encodeURIComponent(search.trim())}`);
            }}
          >
            <TextInput
              radius="xl"
              placeholder="Search the catalog"
              leftSection={<IconSearch size={ICON.md} />}
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              aria-label="Search the catalog"
              rightSection={<Kbd size="xs">Ctrl K</Kbd>}
              rightSectionWidth={64}
            />
          </form>
          <Group gap="3xs" wrap="nowrap">
            <NotificationCenter />
            <Tooltip label="Refresh data">
              <ActionIcon variant="subtle" color="gray" size="lg" onClick={refreshAll} aria-label="Refresh data" aria-busy={refreshing}>
                <IconRefresh size={ICON.lg} className={refreshing ? 'spin' : undefined} />
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
                {colorScheme === 'dark' ? <IconSun size={ICON.lg} /> : <IconMoon size={ICON.lg} />}
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar className="app-navbar" p="sm" data-mini={mini || undefined}>
        {/* On a phone the navigation covers the screen, top bar and burger included: it brings its own way out. */}
        <AppShell.Section hiddenFrom="sm">
          <Group justify="space-between" wrap="nowrap" gap="3xs">
            <UnstyledButton component={Link} to="/" onClick={close} px="xs" py="2xs" display="block" aria-label="Home" miw={0}>
              <BrandMark />
            </UnstyledButton>
            <ActionIcon variant="subtle" color="gray" size="lg" onClick={close} aria-label="Close navigation">
              <IconX size={ICON.lg} />
            </ActionIcon>
          </Group>
        </AppShell.Section>
        <AppShell.Section visibleFrom="sm">
          {mini ? (
            <Stack gap="2xs" align="center">
              <UnstyledButton component={Link} to="/" py="2xs" aria-label="Home">
                <BrandLogo size={28} />
              </UnstyledButton>
              <Tooltip label="Expand sidebar (Ctrl/⌘+B)" position="right">
                <ActionIcon variant="subtle" color="gray" size="lg" onClick={toggleMini} aria-label="Expand sidebar">
                  <IconLayoutSidebarLeftExpand size={ICON.lg} />
                </ActionIcon>
              </Tooltip>
            </Stack>
          ) : (
            <Group justify="space-between" wrap="nowrap" gap="3xs">
              <UnstyledButton component={Link} to="/" onClick={close} px="xs" py="2xs" display="block" aria-label="Home" miw={0}>
                <BrandMark />
              </UnstyledButton>
              <Tooltip label="Collapse sidebar (Ctrl/⌘+B)">
                <ActionIcon variant="subtle" color="gray" size="lg" onClick={toggleMini} aria-label="Collapse sidebar">
                  <IconLayoutSidebarLeftCollapse size={ICON.lg} />
                </ActionIcon>
              </Tooltip>
            </Group>
          )}
        </AppShell.Section>

        {/* Organization switcher: the tenant every page works in. */}
        <AppShell.Section mt="sm">
          <Menu position={mini ? 'right-start' : 'bottom-start'} width={260}>
            <Menu.Target>
              <NavItem
                className="org-switcher"
                mini={mini}
                label={org?.name ?? 'Organization'}
                description={`${isAdmin ? 'Admin' : 'Member'}${user?.organizations && user.organizations.length > 1 ? ` · ${user.organizations.length} organizations` : ''}`}
                ariaLabel={`Organization: ${org?.name ?? 'none'}`}
                tour="org"
                icon={
                  <Avatar radius="md" size={26} color="brand" variant="filled">
                    {initials(org?.name)}
                  </Avatar>
                }
                end={<IconSelector size={ICON.sm} />}
              />
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>Organizations</Menu.Label>
              {user?.organizations?.map((o) => (
                <Menu.Item
                  key={o.id}
                  leftSection={
                    <Avatar radius="sm" size={20} color="brand" variant={o.slug === org?.slug ? 'filled' : 'light'} fz="3xs">
                      {initials(o.name)}
                    </Avatar>
                  }
                  rightSection={o.slug === org?.slug ? <IconCheck size={ICON.sm} /> : undefined}
                  onClick={() => {
                    if (o.slug === org?.slug) return;
                    close();
                    switchOrg(o.slug); // reloads the app at /o/<slug>/
                  }}
                >
                  {o.name}
                </Menu.Item>
              ))}
              {org && !user?.organizations?.some((o) => o.slug === org.slug) && (
                <Menu.Item leftSection={<IconBuilding size={ICON.md} />} rightSection={<IconCheck size={ICON.sm} />} disabled>
                  {org.name} (super-admin)
                </Menu.Item>
              )}
              <Menu.Divider />
              {isAdmin && (
                <Menu.Item component={Link} to="/admin/organization" leftSection={<IconBuilding size={ICON.md} />} onClick={close}>
                  Organization settings
                </Menu.Item>
              )}
              <Menu.Item component={Link} to="/orgs/new" leftSection={<IconPlus size={ICON.md} />} onClick={close}>
                New organization
              </Menu.Item>
              {isSuperadmin && (
                <Menu.Item component={Link} to="/platform/organizations" leftSection={<IconBuildingCommunity size={ICON.md} />} onClick={close}>
                  All organizations
                </Menu.Item>
              )}
            </Menu.Dropdown>
          </Menu>
        </AppShell.Section>

        <AppShell.Section grow component={ScrollArea} mt="3xs" mx={-4} px="3xs">
          <NavItem {...item('/')} label="Home" icon={<IconHome size={ICON.lg} />} />
          <NavItem
            {...item('/todo')}
            label="To do"
            icon={<IconChecklist size={ICON.lg} />}
            count={todoCount}
            ariaLabel={todoCount ? `To do (${todoCount} waiting for you)` : undefined}
            tour="todo"
          />
          <NavItem {...item('/self-service')} label="Self-service" icon={<IconRocket size={ICON.lg} />} tour="self-service" />
          <NavItem {...item('/runs')} label="Runs" icon={<IconActivity size={ICON.lg} />} tour="runs" />
          <NavItem {...item('/catalog')} label="Catalog" icon={<IconCategory2 size={ICON.lg} />} end={entityTotal} tour="catalog" />

          {adminCategories.length > 0 && (
            <div data-tour="admin">
              {section('Administration')}
              {adminCategories.map((c) => (
                <NavItem
                  key={c.id}
                  {...item(c.tabs[0].path)}
                  label={c.title}
                  icon={c.icon}
                  active={c.tabs.some((t) => tabIsActive(location.pathname, t.path))}
                />
              ))}
            </div>
          )}
          {isSuperadmin && (
            <div>
              {section('Platform')}
              <NavItem {...item('/platform/organizations')} label="All organizations" icon={<IconBuildingCommunity size={ICON.lg} />} />
            </div>
          )}
        </AppShell.Section>

        <AppShell.Section pt="xs" className="hairline-top">
          <Menu position="top-start" width={248}>
            <Menu.Target>
              <NavItem
                mini={mini}
                label={user?.name ?? 'Account'}
                description={user?.email}
                ariaLabel="Account"
                tour="account"
                icon={
                  <Avatar radius="xl" size={26} variant="light">
                    {initials(user?.name)}
                  </Avatar>
                }
                end={<IconDots size={ICON.md} />}
              />
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>
                <Group gap="3xs">
                  <Badge size="sm" color={isAdmin ? 'brand' : 'gray'}>
                    {user?.role}
                  </Badge>
                  <RoleBadges roles={user?.roles} size="sm" />
                  {user?.teams.map((t) => (
                    <Badge key={t.identifier} size="sm" color="gray">
                      {t.title}
                    </Badge>
                  ))}
                </Group>
              </Menu.Label>
              <Menu.Item component={Link} to="/profile" leftSection={<IconUser size={ICON.md} />} onClick={close}>
                Profile & API tokens
              </Menu.Item>
              {meta.data?.accountUrl && user?.provider === 'keycloak' && (
                <Menu.Item component="a" href={meta.data.accountUrl} target="_blank" rel="noreferrer" leftSection={<IconShieldLock size={ICON.md} />}>
                  Password, MFA & linked accounts
                </Menu.Item>
              )}
              <Menu.Item leftSection={<IconHelpCircle size={ICON.md} />} onClick={startTour}>
                Take the tour
              </Menu.Item>
              <Menu.Item leftSection={<IconLogout size={ICON.md} />} onClick={() => void signOut()}>
                Sign out
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main className="app-main" id="main-content" tabIndex={-1}>
        {/* Flow views (a run, the workflow editor) fill the panel: no padding, no width limit. */}
        {FLOW_VIEW.test(location.pathname) ? (
          <div className="app-panel app-panel-flush">
            <Outlet />
          </div>
        ) : (
          <div className="app-panel">
            <div className="app-content">
              <Outlet />
            </div>
          </div>
        )}
      </AppShell.Main>
      <Tour steps={tourSteps({ name: user?.name.split(' ')[0] ?? '', isAdmin })} opened={touring} onClose={endTour} />
    </AppShell>
  );
}
