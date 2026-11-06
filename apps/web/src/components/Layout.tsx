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
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
  useMantineColorScheme,
} from '@mantine/core';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import {
  IconActivity,
  IconBolt,
  IconChecklist,
  IconDots,
  IconBell,
  IconHistory,
  IconLayoutDashboard,
  IconMedal,
  IconTrashX,
  IconHome,
  IconKey,
  IconLock,
  IconLogout,
  IconMoon,
  IconPlugConnected,
  IconRobot,
  IconRocket,
  IconSend,
  IconSchema,
  IconSearch,
  IconSettingsAutomation,
  IconSun,
  IconUser,
  IconHelpCircle,
  IconUsersGroup,
  IconWebhook,
} from '@tabler/icons-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Tour } from './Tour';
import { tourSteps } from './tourSteps';
import { useT } from '../lib/i18n';
import { CommandPalette } from './CommandPalette';
import { NotificationCenter } from './NotificationCenter';
import { EntityIcon } from './icons';

const initials = (name = '') =>
  name
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

/** LibreChat-like shell: soft sidebar (brand, navigation, account at the bottom), white canvas, slim header. */
export function Layout() {
  const [opened, { toggle, open, close }] = useDisclosure();
  const [touring, setTouring] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const t = useT();
  const isMobile = useMediaQuery('(max-width: 48em)');
  const qc = useQueryClient();
  const { user, isAdmin, signOut } = useAuth();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const location = useLocation();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const blueprints = useQuery({ queryKey: ['blueprints'], queryFn: api.blueprints, staleTime: 30_000 });
  const approvals = useQuery({ queryKey: ['approvals'], queryFn: api.approvals, refetchInterval: 30_000 });

  const active = (to: string) => (to === '/' ? location.pathname === '/' : location.pathname === to || location.pathname.startsWith(`${to}/`));
  const link = (to: string, label: string, icon: React.ReactNode, right?: React.ReactNode, tour?: string) => (
    <NavLink
      key={to}
      data-tour={tour}
      className="nav-link"
      component={Link}
      to={to}
      label={label}
      leftSection={icon}
      rightSection={right}
      active={active(to)}
      onClick={close}
    />
  );
  const section = (label: string) => <div className="nav-section">{label}</div>;

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
    <AppShell layout="alt" header={{ height: 60 }} navbar={{ width: 264, breakpoint: 'sm', collapsed: { mobile: !opened } }} padding="xl">
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
              <img src="/favicon.svg" width={26} height={26} alt="" />
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

      <AppShell.Navbar className="app-navbar" p="sm">
        <AppShell.Section>
          <UnstyledButton component={Link} to="/" onClick={close} px={10} py={6} visibleFrom="sm">
            <Group gap={10} wrap="nowrap">
              <img src="/favicon.svg" width={28} height={28} alt="" />
              <Text fw={600} fz={16} style={{ letterSpacing: '-0.015em' }}>
                Asterius Platform
              </Text>
            </Group>
          </UnstyledButton>
        </AppShell.Section>

        <AppShell.Section grow component={ScrollArea} mt="sm" mx={-4} px={4}>
          {link('/', 'Home', <IconHome size={18} stroke={1.6} />)}
          {link('/self-service', 'Self-service', <IconRocket size={18} stroke={1.6} />, undefined, 'self-service')}

          <div data-tour="catalog">
            {section('Catalog')}
            {blueprints.data?.map((b) =>
              link(
                `/catalog/${b.identifier}`,
                b.title,
                <EntityIcon name={b.icon} />,
                <Text fz="xs" c="var(--text-3)">
                  {b.entityCount}
                </Text>,
              ),
            )}
          </div>

          {isAdmin && (
            <div data-tour="admin">
              {section('Administration')}
              {link('/admin/blueprints', 'Blueprints', <IconSchema size={18} stroke={1.6} />)}
              {link('/admin/actions', 'Actions', <IconBolt size={18} stroke={1.6} />)}
              {link('/admin/integrations', 'Integrations', <IconPlugConnected size={18} stroke={1.6} />)}
              {link('/admin/dashboards', 'Dashboards', <IconLayoutDashboard size={18} stroke={1.6} />)}
              {link('/admin/scorecards', 'Scorecards', <IconMedal size={18} stroke={1.6} />)}
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
            </div>
          )}
        </AppShell.Section>

        <AppShell.Section pt="xs" style={{ borderTop: '1px solid var(--hairline)' }}>
          <Menu position="top-start" width={248}>
            <Menu.Target>
              <UnstyledButton className="nav-link" w="100%" display="block" aria-label="Account" data-tour="account">
                <Group gap={10} wrap="nowrap">
                  <Avatar radius="xl" size={30} variant="light">
                    {initials(user?.name)}
                  </Avatar>
                  <Box style={{ flex: 1, minWidth: 0 }}>
                    <Text fz={14} fw={500} truncate>
                      {user?.name}
                    </Text>
                    <Text fz={12} c="var(--text-3)" truncate>
                      {user?.email}
                    </Text>
                  </Box>
                  <IconDots size={16} color="var(--text-3)" />
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
        <div className="app-content">
          <Outlet />
        </div>
      </AppShell.Main>
      <Tour steps={tourSteps({ name: user?.name.split(' ')[0] ?? '', isAdmin })} opened={touring} onClose={endTour} />
    </AppShell>
  );
}
