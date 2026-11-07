#!/usr/bin/env node
/**
 * Generates src/components/vendorIcons.generated.ts: official service logos picked from two Iconify sets,
 *   logos   (gilbarbara/logos, CC0-1.0)        → "logos:<name>"
 *   devicon (devicons/devicon, MIT)            → "devicon:<name>"
 * Only the icons listed below are embedded (the sets themselves are dev dependencies, never bundled).
 * Logos drawn in black/near-black are marked `mono`: the UI paints them with the text color, so they stay
 * visible in dark mode.
 *
 *   npm run icons:vendor -w apps/web      (after bumping @iconify-json/logos or @iconify-json/devicon)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sets = {
  logos: require('@iconify-json/logos/icons.json'),
  devicon: require('@iconify-json/devicon/icons.json'),
};

/**
 * [group, [name, title, source, options]] — names are what configuration files use (`icon: kubernetes`).
 * `invert`: multi-color logo with dark parts (e.g. AWS's navy wordmark): inverted (hue kept) in dark mode.
 */
const GROUPS = [
  [
    'Cloud',
    [
      ['azure', 'Microsoft Azure', 'logos:microsoft-azure'],
      ['aws', 'Amazon Web Services', 'logos:aws', { invert: true }],
      ['google-cloud', 'Google Cloud', 'logos:google-cloud'],
      ['cloudflare', 'Cloudflare', 'logos:cloudflare-icon'],
      ['vercel', 'Vercel', 'logos:vercel-icon'],
      ['openshift', 'Red Hat OpenShift', 'logos:openshift'],
      ['redhat', 'Red Hat', 'logos:redhat-icon'],
      ['vmware', 'VMware', 'logos:vmware', { invert: true }],
      ['openstack', 'OpenStack', 'logos:openstack-icon'],
    ],
  ],
  [
    'Azure services',
    [
      ['azure-devops', 'Azure DevOps', 'devicon:azuredevops'],
      ['azure-sql', 'Azure SQL Database', 'devicon:azuresqldatabase'],
      ['cosmos-db', 'Azure Cosmos DB', 'devicon:cosmosdb'],
      ['azure-data-factory', 'Azure Data Factory', 'devicon:azuredatafactory'],
    ],
  ],
  [
    'Delivery',
    [
      ['kubernetes', 'Kubernetes', 'logos:kubernetes'],
      ['helm', 'Helm', 'logos:helm', { invert: true }],
      ['argo-cd', 'Argo CD', 'devicon:argocd'],
      ['terraform', 'Terraform', 'logos:terraform-icon'],
      ['ansible', 'Ansible', 'logos:ansible'],
      ['docker', 'Docker', 'logos:docker-icon'],
      ['github', 'GitHub', 'logos:github-icon'],
      ['github-actions', 'GitHub Actions', 'logos:github-actions'],
      ['gitlab', 'GitLab', 'logos:gitlab-icon'],
      ['bitbucket', 'Bitbucket', 'logos:bitbucket'],
      ['jenkins', 'Jenkins', 'devicon:jenkins'],
      ['circleci', 'CircleCI', 'logos:circleci'],
      ['sonarqube', 'SonarQube', 'devicon:sonarqube'],
      ['harbor', 'Harbor', 'devicon:harbor'],
      ['vault', 'HashiCorp Vault', 'logos:vault-icon'],
    ],
  ],
  [
    'Observability',
    [
      ['prometheus', 'Prometheus', 'logos:prometheus'],
      ['grafana', 'Grafana', 'logos:grafana'],
      ['loki', 'Grafana Loki', 'devicon:grafanaloki'],
      ['opentelemetry', 'OpenTelemetry', 'logos:opentelemetry-icon'],
      ['jaeger', 'Jaeger', 'devicon:jaegertracing'],
      ['datadog', 'Datadog', 'logos:datadog-icon'],
      ['sentry', 'Sentry', 'logos:sentry-icon', { invert: true }],
      ['pagerduty', 'PagerDuty', 'logos:pagerduty-icon'],
      ['elasticsearch', 'Elasticsearch', 'devicon:elasticsearch'],
    ],
  ],
  [
    'Data',
    [
      ['postgresql', 'PostgreSQL', 'logos:postgresql'],
      ['mysql', 'MySQL', 'logos:mysql-icon'],
      ['sql-server', 'SQL Server', 'devicon:microsoftsqlserver'],
      ['oracle', 'Oracle', 'logos:oracle'],
      ['redis', 'Redis', 'logos:redis'],
      ['mongodb', 'MongoDB', 'logos:mongodb-icon'],
      ['kafka', 'Apache Kafka', 'logos:kafka-icon'],
      ['rabbitmq', 'RabbitMQ', 'logos:rabbitmq-icon'],
      ['snowflake', 'Snowflake', 'logos:snowflake-icon'],
      ['databricks', 'Databricks', 'logos:databricks-icon'],
    ],
  ],
  [
    'Collaboration & identity',
    [
      ['jira', 'Jira', 'logos:jira'],
      ['confluence', 'Confluence', 'logos:confluence'],
      ['slack', 'Slack', 'logos:slack-icon'],
      ['microsoft-teams', 'Microsoft Teams', 'logos:microsoft-teams'],
      ['servicenow', 'ServiceNow', 'devicon:servicenow'],
      ['okta', 'Okta', 'logos:okta-icon'],
      ['auth0', 'Auth0', 'logos:auth0-icon'],
    ],
  ],
  [
    'AI',
    [
      ['anthropic', 'Anthropic', 'logos:anthropic-icon'],
      ['claude', 'Claude', 'logos:claude-icon'],
      ['openai', 'OpenAI', 'logos:openai-icon'],
    ],
  ],
  [
    'Languages & platforms',
    [
      ['python', 'Python', 'logos:python'],
      ['nodejs', 'Node.js', 'devicon:nodejs'],
      ['java', 'Java', 'logos:java'],
      ['dotnet', '.NET', 'logos:dotnet'],
      ['go', 'Go', 'devicon:go'],
      ['rust', 'Rust', 'logos:rust'],
      ['typescript', 'TypeScript', 'logos:typescript-icon'],
      ['react', 'React', 'logos:react'],
      ['angular', 'Angular', 'logos:angular-icon'],
      ['vue', 'Vue.js', 'logos:vue'],
      ['powershell', 'PowerShell', 'devicon:powershell'],
      ['bash', 'Bash', 'logos:bash-icon'],
      ['linux', 'Linux', 'logos:linux-tux'],
      ['ubuntu', 'Ubuntu', 'logos:ubuntu'],
      ['windows', 'Windows', 'logos:microsoft-windows-icon'],
    ],
  ],
];

function resolve(source) {
  const [prefix, name] = source.split(':');
  const set = sets[prefix];
  if (!set) throw new Error(`unknown set ${prefix}`);
  let icon = set.icons[name];
  let alias = set.aliases?.[name];
  if (!icon && alias) icon = { ...set.icons[alias.parent], ...alias };
  if (!icon) throw new Error(`${source} not found`);
  const w = icon.width ?? set.width ?? 16;
  const h = icon.height ?? set.height ?? 16;
  return { body: icon.body, viewBox: `${icon.left ?? 0} ${icon.top ?? 0} ${w} ${h}` };
}

/** Every color of the logo is black / dark gray (or currentColor): it needs the theme's text color. */
function isMono(body) {
  const colors = [...body.matchAll(/(?:fill|stroke|stop-color)\s*[=:]\s*"?(#[0-9a-fA-F]{3,8}|currentColor|black)/g)].map((m) => m[1]);
  if (!colors.length) return true; // default fill is black
  return colors.every((c) => {
    if (c === 'currentColor' || c === 'black') return true;
    let hex = c.slice(1);
    if (hex.length <= 4) hex = [...hex].map((x) => x + x).join('');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    // dark AND gray: a dark brand hue (Helm navy) keeps its color and uses `invert` instead
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.25 && Math.max(r, g, b) - Math.min(r, g, b) < 0.12;
  });
}

const out = [];
let total = 0;
for (const [group, icons] of GROUPS) {
  const entries = icons.map(([name, title, source, opts = {}]) => {
    const { body, viewBox } = resolve(source);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body.replace(/currentColor/g, '#000')}</svg>`;
    total += svg.length;
    if (svg.length > 12_000) console.warn(`  ${name}: ${(svg.length / 1024).toFixed(1)} KB`);
    return { name, title, source, mono: isMono(body), invert: !!opts.invert, svg };
  });
  out.push({ group, icons: entries });
}

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = (p) => JSON.parse(readFileSync(require.resolve(`${p}/package.json`), 'utf8')).version;
const target = path.join(here, '../src/components/vendorIcons.generated.ts');
writeFileSync(
  target,
  `// Generated by scripts/gen-vendor-icons.mjs — do not edit.
// Sources: @iconify-json/logos ${pkg('@iconify-json/logos')} (CC0-1.0), @iconify-json/devicon ${pkg('@iconify-json/devicon')} (MIT).
// Logos are trademarks of their owners, shown to identify their services.

export interface VendorIcon {
  name: string;
  title: string;
  source: string;
  /** Black-only logo: painted with the text color (dark mode). */
  mono: boolean;
  /** Multi-color logo with dark parts: inverted (hue kept) in dark mode. */
  invert: boolean;
  svg: string;
}

export const VENDOR_ICON_GROUPS: { group: string; icons: VendorIcon[] }[] = ${JSON.stringify(out, null, 2)};
`,
);
console.log(`${out.reduce((n, g) => n + g.icons.length, 0)} vendor icons, ${(total / 1024).toFixed(0)} KB → ${path.relative(process.cwd(), target)}`);
