import {
  IconActivity,
  IconApi,
  IconApiApp,
  IconAppWindow,
  IconApps,
  IconAtom,
  IconAward,
  IconBell,
  IconBolt,
  IconBook,
  IconBox,
  IconBrackets,
  IconBrain,
  IconBrandGoogle,
  IconBrandJavascript,
  IconBriefcase,
  IconBucket,
  IconBug,
  IconBuilding,
  IconBuildingBank,
  IconCalendar,
  IconCertificate,
  IconChartBar,
  IconChartLine,
  IconChecklist,
  IconClipboard,
  IconCloud,
  IconCloudComputing,
  IconCode,
  IconCoin,
  IconContainer,
  IconCpu,
  IconCreditCard,
  IconCube,
  IconDatabase,
  IconDeviceDesktop,
  IconDeviceMobile,
  IconDiamond,
  IconFile,
  IconFileText,
  IconFingerprint,
  IconFlag,
  IconFlame,
  IconFolder,
  IconGauge,
  IconGitBranch,
  IconGitMerge,
  IconGitPullRequest,
  IconGlobe,
  IconHeadset,
  IconHeart,
  IconHexagon,
  IconId,
  IconInbox,
  IconInfinity,
  IconKey,
  IconLambda,
  IconLayout,
  IconLeaf,
  IconLifebuoy,
  IconLock,
  IconMail,
  IconMap,
  IconMessage,
  IconMicroscope,
  IconNetwork,
  IconPackage,
  IconPalette,
  IconPhoto,
  IconPlayerPlay,
  IconPlug,
  IconPlus,
  IconPuzzle,
  IconRefresh,
  IconReport,
  IconRobot,
  IconRocket,
  IconRouter,
  IconSearch,
  IconServer,
  IconServer2,
  IconSettings,
  IconShield,
  IconShieldCheck,
  IconShoppingCart,
  IconSitemap,
  IconSparkles,
  IconStack,
  IconStack2,
  IconStar,
  IconTag,
  IconTerminal2,
  IconTicket,
  IconTool,
  IconTopologyStar3,
  IconTrash,
  IconTruck,
  IconUser,
  IconUsers,
  IconUsersGroup,
  IconWallet,
  IconWebhook,
  IconWorld,
  type Icon,
} from '@tabler/icons-react';
import { VENDOR_ICON_GROUPS, type VendorIcon } from './vendorIcons.generated';

/**
 * Icons that blueprints and actions may name in configuration: official service logos (`icon: azure-devops`,
 * `kubernetes`…) and generic Tabler icons (`icon: rocket`: Tabler names without the `Icon` prefix, kebab-case). An icon can also be a custom image: an https:// URL or an uploaded data:image/… URI.
 * Unknown names fall back to a box.
 */
export const ICON_GROUPS: { label: string; icons: Record<string, Icon> }[] = [
  {
    label: 'Software',
    icons: {
      apps: IconApps,
      'app-window': IconAppWindow,
      api: IconApi,
      'api-app': IconApiApp,
      code: IconCode,
      brackets: IconBrackets,
      terminal: IconTerminal2,
      bug: IconBug,
      package: IconPackage,
      box: IconBox,
      cube: IconCube,
      puzzle: IconPuzzle,
      layout: IconLayout,
      'git-branch': IconGitBranch,
      'git-pull-request': IconGitPullRequest,
      'git-merge': IconGitMerge,
      lambda: IconLambda,
      webhook: IconWebhook,
    },
  },
  {
    label: 'Infrastructure',
    icons: {
      server: IconServer,
      'server-2': IconServer2,
      database: IconDatabase,
      cloud: IconCloud,
      'cloud-computing': IconCloudComputing,
      container: IconContainer,
      stack: IconStack,
      'stack-2': IconStack2,
      cpu: IconCpu,
      network: IconNetwork,
      router: IconRouter,
      sitemap: IconSitemap,
      topology: IconTopologyStar3,
      bucket: IconBucket,
      world: IconWorld,
      globe: IconGlobe,
      'device-desktop': IconDeviceDesktop,
      'device-mobile': IconDeviceMobile,
    },
  },
  {
    label: 'Security & access',
    icons: {
      lock: IconLock,
      key: IconKey,
      shield: IconShield,
      'shield-check': IconShieldCheck,
      certificate: IconCertificate,
      fingerprint: IconFingerprint,
      id: IconId,
      user: IconUser,
      users: IconUsers,
      'users-group': IconUsersGroup,
    },
  },
  {
    label: 'Operations',
    icons: {
      rocket: IconRocket,
      bolt: IconBolt,
      'player-play': IconPlayerPlay,
      refresh: IconRefresh,
      plus: IconPlus,
      trash: IconTrash,
      settings: IconSettings,
      tool: IconTool,
      activity: IconActivity,
      gauge: IconGauge,
      'chart-bar': IconChartBar,
      'chart-line': IconChartLine,
      bell: IconBell,
      flame: IconFlame,
      lifebuoy: IconLifebuoy,
      checklist: IconChecklist,
      ticket: IconTicket,
      robot: IconRobot,
      brain: IconBrain,
      sparkles: IconSparkles,
    },
  },
  {
    label: 'Business',
    icons: {
      building: IconBuilding,
      'building-bank': IconBuildingBank,
      briefcase: IconBriefcase,
      wallet: IconWallet,
      'credit-card': IconCreditCard,
      coin: IconCoin,
      'shopping-cart': IconShoppingCart,
      truck: IconTruck,
      headset: IconHeadset,
      mail: IconMail,
      message: IconMessage,
      calendar: IconCalendar,
      report: IconReport,
      clipboard: IconClipboard,
      file: IconFile,
      'file-text': IconFileText,
      folder: IconFolder,
      book: IconBook,
      inbox: IconInbox,
      map: IconMap,
    },
  },
  {
    label: 'Misc',
    icons: {
      star: IconStar,
      heart: IconHeart,
      flag: IconFlag,
      tag: IconTag,
      award: IconAward,
      diamond: IconDiamond,
      hexagon: IconHexagon,
      atom: IconAtom,
      infinity: IconInfinity,
      leaf: IconLeaf,
      microscope: IconMicroscope,
      palette: IconPalette,
      photo: IconPhoto,
      search: IconSearch,
      plug: IconPlug,
    },
  },
];

const ICONS: Record<string, Icon> = Object.assign(
  { 'brand-google': IconBrandGoogle, 'brand-javascript': IconBrandJavascript },
  ...ICON_GROUPS.map((g) => g.icons),
);

/** Official service logos (generated from Iconify sets, see scripts/gen-vendor-icons.mjs). */
const VENDOR: Record<string, VendorIcon & { url: string }> = Object.fromEntries(
  VENDOR_ICON_GROUPS.flatMap((g) => g.icons).map((i) => [i.name, { ...i, url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(i.svg)}` }]),
);

/** Earlier `brand-*` names (Tabler glyphs) now show the vendor's own logo. */
const ALIASES: Record<string, string> = {
  'brand-azure': 'azure',
  'brand-aws': 'aws',
  'brand-kubernetes': 'kubernetes',
  'brand-docker': 'docker',
  'brand-terraform': 'terraform',
  'brand-github': 'github',
  'brand-gitlab': 'gitlab',
  'brand-vercel': 'vercel',
  'brand-python': 'python',
  'brand-typescript': 'typescript',
  'brand-nodejs': 'nodejs',
  'brand-golang': 'go',
  'brand-react': 'react',
  'brand-slack': 'slack',
  'brand-teams': 'microsoft-teams',
  'brand-openai': 'openai',
};

/** Picker sections: service logos first, then the generic icons. */
export const PICKER_GROUPS: { label: string; icons: { name: string; title: string }[] }[] = [
  ...VENDOR_ICON_GROUPS.map((g) => ({ label: g.group, icons: g.icons.map((i) => ({ name: i.name, title: i.title })) })),
  ...ICON_GROUPS.map((g) => ({ label: g.label, icons: Object.keys(g.icons).map((n) => ({ name: n, title: n })) })),
];

export const ICON_NAMES = [...Object.keys(VENDOR), ...Object.keys(ICONS)];

/** Display name of an icon value (picker, tooltips). */
export const iconTitle = (name: string) => VENDOR[ALIASES[name] ?? name]?.title ?? name;

/** A custom image icon (URL or uploaded data URI) rather than a built-in icon name. */
export const isImageIcon = (v: string | null | undefined): v is string => !!v && /^(https:\/\/|\/|data:image\/)/.test(v);

export function EntityIcon({ name, size = 18 }: { name?: string | null; size?: number }) {
  const vendor = name ? VENDOR[ALIASES[name] ?? name] : undefined;
  if (vendor)
    return vendor.mono ? (
      // Black-only logos take the text color, so they stay visible in dark mode.
      <span
        role="img"
        aria-hidden
        style={{
          width: size,
          height: size,
          flexShrink: 0,
          display: 'block',
          backgroundColor: 'currentColor',
          mask: `url("${vendor.url}") center / contain no-repeat`,
          WebkitMask: `url("${vendor.url}") center / contain no-repeat`,
        }}
      />
    ) : (
      <img
        src={vendor.url}
        width={size}
        height={size}
        alt=""
        className={vendor.invert ? 'vendor-invert-dark' : undefined}
        style={{ objectFit: 'contain', flexShrink: 0, display: 'block' }}
      />
    );
  if (isImageIcon(name))
    return <img src={name} width={size} height={size} alt="" style={{ objectFit: 'contain', borderRadius: 4, flexShrink: 0, display: 'block' }} />;
  const C = (name && ICONS[name]) || IconBox;
  return <C size={size} stroke={1.6} />;
}
