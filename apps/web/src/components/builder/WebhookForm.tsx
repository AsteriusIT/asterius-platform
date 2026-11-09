import { Button, Group, MultiSelect, Select, Stack, Switch, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { IconSend } from '@tabler/icons-react';
import { api } from '../../lib/api';
import { useAppMutation } from '../../lib/queryClient';
import { MONO_INPUT } from './blocks';
import type { Doc } from './FormEditor';

export const WEBHOOK_EVENT_OPTIONS = [
  { value: '*', label: 'Everything (*)' },
  { value: 'entity.*', label: 'Any entity change' },
  { value: 'entity.created', label: 'Entity created' },
  { value: 'entity.updated', label: 'Entity updated' },
  { value: 'entity.deleted', label: 'Entity deleted' },
  { value: 'run.*', label: 'Any run change' },
  { value: 'run.created', label: 'Run created' },
  { value: 'run.updated', label: 'Run updated' },
  { value: 'run.sla_breached', label: 'Run SLA breached' },
  { value: 'step.sla_breached', label: 'Step SLA breached' },
];

const SECRET_REF = /^\$\{secret:([A-Za-z0-9_.-]+)\}$/;

export function WebhookForm({ doc, patch, isNew }: { doc: Doc; patch: (p: Doc) => void; isNew: boolean }) {
  const blueprints = useQuery({ queryKey: ['blueprints'], queryFn: api.blueprints, staleTime: 30_000 });
  const secrets = useQuery({ queryKey: ['secrets'], queryFn: api.secrets, staleTime: 30_000 });
  const id = String(doc.identifier ?? '');
  const secret = typeof doc.secret === 'string' ? doc.secret : '';
  const url = String(doc.url ?? '');
  const urlError = url && !/^https?:\/\/\S+$/.test(url) ? 'Must be an http(s) URL' : undefined;
  const test = useAppMutation({
    mutationFn: () => api.testWebhook(id),
    onSuccess: () => notifications.show({ color: 'green', message: 'Test delivery queued: see Deliveries for the result' }),
  });
  const secretNames = (secrets.data ?? []).map((s) => s.name);
  return (
    <Stack gap="md">
      <Group grow align="flex-start">
        <TextInput label="Identifier" value={id} disabled={!isNew} onChange={(e) => patch({ identifier: e.currentTarget.value })} styles={MONO_INPUT} />
        <TextInput label="Title" value={String(doc.title ?? '')} onChange={(e) => patch({ title: e.currentTarget.value })} />
      </Group>
      <TextInput label="URL" placeholder="https://example.internal/hook" value={url} error={urlError} onChange={(e) => patch({ url: e.currentTarget.value })} />
      <MultiSelect
        label="Events"
        data={WEBHOOK_EVENT_OPTIONS}
        value={Array.isArray(doc.events) ? (doc.events as string[]) : []}
        onChange={(v) => patch({ events: v })}
        error={Array.isArray(doc.events) && doc.events.length === 0 ? 'Pick at least one event' : undefined}
      />
      <MultiSelect
        label="Only for blueprints"
        description="Empty: all blueprints"
        searchable
        data={(blueprints.data ?? []).map((b) => ({ value: b.identifier, label: b.title }))}
        value={Array.isArray(doc.blueprints) ? (doc.blueprints as string[]) : []}
        onChange={(v) => patch({ blueprints: v })}
      />
      <Select
        label="Signing secret"
        description="Deliveries carry X-Asterius-Signature (HMAC-SHA256) computed with this secret"
        clearable
        searchable
        data={secretNames.map((n) => ({ value: `\${secret:${n}}`, label: n }))}
        value={SECRET_REF.test(secret) ? secret : null}
        onChange={(v) => patch({ secret: v })}
        nothingFoundMessage="No secret yet: create one under Secrets"
      />
      {secret && !SECRET_REF.test(secret) && (
        <Text fz="xs" c="orange">
          The secret is not a reference (${'{secret:NAME}'}); edit it in the YAML tab or pick a secret above.
        </Text>
      )}
      <Group justify="space-between">
        <Switch label="Enabled" checked={doc.enabled !== false} onChange={(e) => patch({ enabled: e.currentTarget.checked })} />
        <Button size="xs" variant="default" leftSection={<IconSend size={14} />} disabled={isNew} loading={test.isPending} onClick={() => test.mutate()}>
          Send test delivery
        </Button>
      </Group>
      {isNew && (
        <Text fz="xs" c="dimmed">
          Save the webhook first to send a test delivery.
        </Text>
      )}
    </Stack>
  );
}
