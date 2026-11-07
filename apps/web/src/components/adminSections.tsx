import type { ReactNode } from 'react';
import {
  IconBell,
  IconBolt,
  IconBuilding,
  IconHistory,
  IconKey,
  IconLayoutDashboard,
  IconLock,
  IconMedal,
  IconPlugConnected,
  IconRobot,
  IconSchema,
  IconSend,
  IconSettingsAutomation,
  IconShieldCheck,
  IconTrashX,
  IconUsersGroup,
  IconWebhook,
} from '@tabler/icons-react';

export interface AdminTab {
  label: string;
  /** Existing page route, e.g. /admin/actions. */
  path: string;
  icon: ReactNode;
}
export interface AdminCategory {
  id: string;
  title: string;
  /** Category URL: redirects to the first tab. */
  path: string;
  icon: ReactNode;
  tabs: AdminTab[];
}

const i = (I: typeof IconBolt) => <I size={16} stroke={1.6} />;

/** Single source of truth for the admin sidebar, the in-page tabs and the command palette. */
export const ADMIN_CATEGORIES: AdminCategory[] = [
  {
    id: 'model',
    title: 'Catalog model',
    path: '/admin/model',
    icon: i(IconSchema),
    tabs: [
      { label: 'Blueprints', path: '/admin/blueprints', icon: i(IconSchema) },
      { label: 'Dashboards', path: '/admin/dashboards', icon: i(IconLayoutDashboard) },
      { label: 'Scorecards', path: '/admin/scorecards', icon: i(IconMedal) },
    ],
  },
  {
    id: 'automation',
    title: 'Automation',
    path: '/admin/automation',
    icon: i(IconBolt),
    tabs: [
      { label: 'Actions', path: '/admin/actions', icon: i(IconBolt) },
      { label: 'Integrations', path: '/admin/integrations', icon: i(IconPlugConnected) },
      { label: 'Webhooks', path: '/admin/webhooks', icon: i(IconWebhook) },
      { label: 'Deliveries', path: '/admin/deliveries', icon: i(IconSend) },
      { label: 'Notifications', path: '/admin/notifications', icon: i(IconBell) },
    ],
  },
  {
    id: 'access',
    title: 'Access',
    path: '/admin/access',
    icon: i(IconKey),
    tabs: [
      { label: 'Teams', path: '/admin/teams', icon: i(IconUsersGroup) },
      { label: 'Users & service accounts', path: '/admin/users', icon: i(IconKey) },
      { label: 'Secrets', path: '/admin/secrets', icon: i(IconLock) },
    ],
  },
  {
    id: 'governance',
    title: 'Governance',
    path: '/admin/governance',
    icon: i(IconShieldCheck),
    tabs: [
      { label: 'Policies', path: '/admin/policies', icon: i(IconShieldCheck) },
      { label: 'Audit log', path: '/admin/audit', icon: i(IconHistory) },
      { label: 'Deleted entities', path: '/admin/deleted', icon: i(IconTrashX) },
    ],
  },
  {
    id: 'settings',
    title: 'Settings',
    path: '/admin/settings',
    icon: i(IconSettingsAutomation),
    tabs: [
      { label: 'Organization', path: '/admin/organization', icon: i(IconBuilding) },
      { label: 'Configuration', path: '/admin/config', icon: i(IconSettingsAutomation) },
      { label: 'AI usage', path: '/admin/ai', icon: i(IconRobot) },
    ],
  },
];

const matches = (pathname: string, p: string) => pathname === p || pathname.startsWith(`${p}/`);

export function categoryForPath(pathname: string): AdminCategory | undefined {
  return ADMIN_CATEGORIES.find((c) => c.tabs.some((t) => matches(pathname, t.path)));
}

export const tabIsActive = matches;
