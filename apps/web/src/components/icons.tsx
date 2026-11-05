import {
  IconApps,
  IconBolt,
  IconBox,
  IconBrandAzure,
  IconBrandDocker,
  IconBrandGithub,
  IconBrandGitlab,
  IconSteeringWheel,
  IconBug,
  IconCloud,
  IconCode,
  IconContainer,
  IconCube,
  IconDatabase,
  IconGitBranch,
  IconKey,
  IconLock,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
  IconRocket,
  IconServer,
  IconSettings,
  IconShieldCheck,
  IconSitemap,
  IconTerminal2,
  IconTrash,
  IconUsers,
  IconWebhook,
  IconWorld,
  type Icon,
} from '@tabler/icons-react';

/**
 * Icons that blueprints and actions may name in configuration (`icon: rocket`). Tabler names without the
 * `Icon` prefix, kebab-case. Unknown names fall back to a box.
 */
const ICONS: Record<string, Icon> = {
  apps: IconApps,
  bolt: IconBolt,
  box: IconBox,
  'brand-azure': IconBrandAzure,
  'brand-docker': IconBrandDocker,
  'brand-github': IconBrandGithub,
  'brand-gitlab': IconBrandGitlab,
  'brand-kubernetes': IconSteeringWheel, // the Kubernetes helm wheel (no brand icon in Tabler)
  container: IconContainer,
  cube: IconCube,
  bug: IconBug,
  cloud: IconCloud,
  code: IconCode,
  database: IconDatabase,
  'git-branch': IconGitBranch,
  key: IconKey,
  lock: IconLock,
  'player-play': IconPlayerPlay,
  plus: IconPlus,
  refresh: IconRefresh,
  rocket: IconRocket,
  server: IconServer,
  settings: IconSettings,
  'shield-check': IconShieldCheck,
  sitemap: IconSitemap,
  terminal: IconTerminal2,
  trash: IconTrash,
  users: IconUsers,
  webhook: IconWebhook,
  world: IconWorld,
};

export const ICON_NAMES = Object.keys(ICONS);

export function EntityIcon({ name, size = 18 }: { name?: string | null; size?: number }) {
  const C = (name && ICONS[name]) || IconBox;
  return <C size={size} stroke={1.6} />;
}
