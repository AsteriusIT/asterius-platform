import { Code } from '@mantine/core';
import type { TourStep } from './Tour';

/** The onboarding tour of the portal. Targets are `data-tour` attributes set in Layout.tsx. */
export function tourSteps(opts: { name: string; isAdmin: boolean }): TourStep[] {
  return [
    {
      title: `Welcome, ${opts.name}`,
      body: (
        <>
          Asterius Platform is your team's developer portal: a catalog of everything we build and run, and self-service golden paths to change it. One minute to
          show you around?
        </>
      ),
    },
    {
      target: 'catalog',
      title: 'The software catalog',
      body: (
        <>
          Services, systems, environments, repositories… each kind has its own page. Entities show their owner team, properties, relations and the actions you
          can run on them. Much of it is kept up to date automatically from GitHub, Azure DevOps or Kubernetes.
        </>
      ),
    },
    {
      target: 'search',
      title: 'Find anything',
      body: 'Search across the whole catalog by name or identifier.',
      placement: 'bottom',
    },
    {
      target: 'self-service',
      title: 'Self-service',
      body: (
        <>
          Create a service, request an environment and more, through forms. Actions that need it go through approval first, then run the pipelines for you.
          Actions on an existing entity (deploy, change lifecycle…) are on that entity's page.
        </>
      ),
    },
    {
      target: 'approvals',
      title: 'Approvals',
      body: 'Requests waiting for your decision: a counter appears on this icon. Your own requests are approved by someone else.',
      placement: 'bottom',
    },
    {
      target: 'runs',
      title: 'Follow your runs',
      body: 'Every request becomes a run: its status, live logs, approvals and a link to the pipeline or the resource it created.',
      placement: 'bottom',
    },
    ...(opts.isAdmin
      ? [
          {
            target: 'admin',
            title: 'Administration',
            body: (
              <>
                Define blueprints, actions, integrations and webhooks: in YAML here, or as code in the configuration repository (<Code>CONFIG_DIR</Code>).
                Secrets are stored encrypted and referenced as <Code>{'${secret:NAME}'}</Code>.
              </>
            ),
          } satisfies TourStep,
        ]
      : []),
    {
      target: 'account',
      title: 'Your account',
      body: 'Your teams, personal API tokens for scripts, sign-out, and this tour again whenever you need it.',
      placement: 'top',
    },
    {
      title: "You're all set",
      body: 'A good first step: open Self-service and look at what you can request.',
      finishLabel: 'Open Self-service',
    },
  ];
}
