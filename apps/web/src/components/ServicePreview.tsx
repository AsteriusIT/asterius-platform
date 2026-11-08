import { Alert, Badge, Group, List, Stack, Text, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconShieldCheck, IconShieldX } from '@tabler/icons-react';
import type { Action } from '@asterius/shared';
import type { ServicePreview as Preview } from '../lib/api';
import { CodeBlock } from './CodeEditor';
import { DataTable } from './DataTable';

/** Workflows with a V2 pre-check step get a preview before they are submitted. */
export const hasServicePreview = (a: Pick<Action, 'steps'>) =>
  a.steps.some((s) => s.type === 'invoke' && (s as { invoker?: { type?: string } }).invoker?.type === 'service-precheck');

type Resource = NonNullable<Preview['render']>['resources'][number];

/** Plan actions (plan service) → label, colour and what it means for the requester. */
const ACTIONS: Record<string, { label: string; color: string; help: string }> = {
  create: { label: 'create', color: 'green', help: 'Will be created' },
  import: { label: 'import', color: 'blue', help: 'Already exists, will be adopted' },
  update: { label: 'update', color: 'yellow', help: 'Will be changed in place' },
  delete: { label: 'delete', color: 'red', help: 'Will be deleted' },
  'no-op': { label: 'no change', color: 'gray', help: 'Already as specified' },
};

function ActionBadge({ r }: { r: Resource }) {
  const a = ACTIONS[r.action ?? ''] ?? { label: r.action ?? '', color: 'gray', help: '' };
  return (
    <Tooltip label={r.replace ? 'Will be replaced (deleted, then created again)' : a.help} disabled={!a.help && !r.replace}>
      <Badge size="sm" variant="light" color={r.replace ? 'orange' : a.color}>
        {r.replace ? 'replace' : a.label}
      </Badge>
    </Tooltip>
  );
}

/** "2 to create, 1 already exists (adopted)" */
function summary(resources: Resource[]): string {
  const n = (a: string) => resources.filter((r) => r.action === a).length;
  const parts = [
    n('create') && `${n('create')} to create`,
    n('import') && `${n('import')} already exist${n('import') > 1 ? '' : 's'} (adopted)`,
    n('update') && `${n('update')} to change`,
    n('delete') && `${n('delete')} to delete`,
  ].filter(Boolean);
  return parts.join(', ');
}

/**
 * What a V2 request will do: the policy result, the resources of the plan (OpenTofu: created, adopted because they
 * already exist, changed, deleted; Crossplane render: composed) and the spec committed.
 */
export function ServicePreview({ preview }: { preview: Preview }) {
  const policy = preview.policy;
  const render = preview.render;
  const withActions = render?.status === 'ok' && render.resources.some((r) => r.action);
  const fromPlan = render?.status === 'ok' && render.resources.some((r) => !r.apiVersion);
  return (
    <Stack gap="sm" aria-label="Preview">
      {!!preview.inputErrors?.length && (
        <Alert color="red" variant="light" title="Check the form">
          <List size="sm">
            {preview.inputErrors.map((e) => (
              <List.Item key={e}>{e}</List.Item>
            ))}
          </List>
        </Alert>
      )}
      {policy?.status === 'allowed' && (
        <Alert color="green" variant="light" icon={<IconShieldCheck size={18} />} title="Policies passed">
          The request complies with the platform policies.
        </Alert>
      )}
      {policy?.status === 'denied' && (
        <Alert color="red" variant="light" icon={<IconShieldX size={18} />} title="Denied by policy">
          <List size="sm">
            {policy.violations.map((v, i) => (
              <List.Item key={`${v.policy}-${i}`}>
                <b>{v.policy}</b>: {v.msg}
              </List.Item>
            ))}
          </List>
        </Alert>
      )}
      {policy?.status === 'unavailable' && (
        <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={18} />} title="Policy check unavailable">
          {policy.error ?? 'The policy service did not answer.'} The run checks again before anything is committed, and stops if it still cannot.
        </Alert>
      )}
      {preview.schema?.status === 'unavailable' && (
        <Text fz="xs" c="dimmed">
          Schema check unavailable ({preview.schema.error}); the policies still apply.
        </Text>
      )}
      <Group gap="xs">
        <Text fw={600} fz="sm">
          {withActions ? 'Planned changes' : 'Resources to be created'}
        </Text>
        {render?.status === 'ok' && <Badge variant="light">{render.resources.length}</Badge>}
        {withActions && render?.status === 'ok' && (
          <Text fz="xs" c="dimmed">
            {summary(render.resources)}
          </Text>
        )}
      </Group>
      {render?.status === 'ok' ? (
        <DataTable<Resource>
          rows={render.resources}
          rowKey={(r) => `${r.apiVersion ?? ''}/${r.kind}/${r.name}`}
          empty={<Text c="dimmed">{fromPlan ? 'The plan has no changes for this spec.' : 'The golden path renders no resources for this spec.'}</Text>}
          columns={[
            ...(withActions ? [{ key: 'action', label: 'Action', render: (r: Resource) => <ActionBadge r={r} /> }] : []),
            { key: 'kind', label: fromPlan ? 'Type' : 'Kind', render: (r) => r.kind },
            {
              key: 'name',
              label: fromPlan ? 'Address' : 'Name',
              render: (r) => (
                <Text fz="xs" ff={fromPlan ? 'monospace' : undefined}>
                  {r.name}
                </Text>
              ),
            },
            { key: 'externalName', label: fromPlan ? 'Name in Azure DevOps' : 'External name', render: (r) => r.externalName ?? '' },
            ...(fromPlan ? [] : [{ key: 'apiVersion', label: 'API version', render: (r: Resource) => <Text fz="xs">{r.apiVersion}</Text> }]),
          ]}
        />
      ) : (
        <Text fz="sm" c="dimmed">
          {render?.status === 'skipped' ? 'No plan for this operation.' : `Preview of the resources unavailable: ${render?.error ?? 'no plan service'}.`}
        </Text>
      )}
      {preview.specYaml && (
        <>
          <Text fw={600} fz="sm">
            Spec{' '}
            {preview.specPath ? (
              <Text span ff="monospace" fz="xs">
                {preview.specPath}
              </Text>
            ) : null}
          </Text>
          <CodeBlock code={preview.specYaml} language="yaml" maxHeight={320} aria-label="Service spec" />
        </>
      )}
    </Stack>
  );
}
