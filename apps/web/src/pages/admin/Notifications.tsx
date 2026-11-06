import { useEffect, useState } from 'react';
import { Button, Card, Group, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotificationSettings } from '@asterius/shared';
import { api, errorText } from '../../lib/api';
import { PageHeader, QueryView } from '../../components/ui';

/** Admin → Notifications: default credentials and channels used by the Slack, Teams and email invokers and by approval / run notifications. */

const onError = (e: unknown) => notifications.show({ color: 'red', message: errorText(e) });

function Form({ initial }: { initial: NotificationSettings }) {
  const qc = useQueryClient();
  const [s, setS] = useState(initial);
  useEffect(() => setS(initial), [initial]);
  const set = <K extends keyof NotificationSettings>(k: K, patch: Partial<NotificationSettings[K]>) => setS((x) => ({ ...x, [k]: { ...x[k], ...patch } }));
  const empty = (v: string) => v || undefined;
  const save = useMutation({
    mutationFn: () => api.saveNotificationSettings(s),
    onSuccess: () => {
      notifications.show({ color: 'green', message: 'Saved' });
      void qc.invalidateQueries({ queryKey: ['notification-settings'] });
    },
    onError,
  });
  const test = useMutation({
    mutationFn: (channel: 'slack' | 'teams' | 'email') => api.testNotification(channel),
    onSuccess: () => notifications.show({ color: 'green', message: 'Test message sent' }),
    onError,
  });
  const secretHint = 'A secret reference such as ${secret:SLACK_BOT_TOKEN}';
  return (
    <Stack>
      <Card>
        <Group justify="space-between" mb="xs">
          <Title order={5}>Slack</Title>
          <Button size="xs" variant="default" loading={test.isPending && test.variables === 'slack'} onClick={() => test.mutate('slack')}>
            Send a test
          </Button>
        </Group>
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <TextInput
            label="Bot token"
            description={secretHint}
            value={s.slack.botToken ?? ''}
            onChange={(e) => set('slack', { botToken: empty(e.currentTarget.value) })}
          />
          <TextInput
            label="Incoming webhook URL"
            description="Used when there is no bot token"
            value={s.slack.webhookUrl ?? ''}
            onChange={(e) => set('slack', { webhookUrl: empty(e.currentTarget.value) })}
          />
          <TextInput
            label="Default channel"
            placeholder="#platform"
            value={s.slack.defaultChannel ?? ''}
            onChange={(e) => set('slack', { defaultChannel: empty(e.currentTarget.value) })}
          />
        </SimpleGrid>
      </Card>
      <Card>
        <Group justify="space-between" mb="xs">
          <Title order={5}>Microsoft Teams</Title>
          <Button size="xs" variant="default" loading={test.isPending && test.variables === 'teams'} onClick={() => test.mutate('teams')}>
            Send a test
          </Button>
        </Group>
        <TextInput
          label="Webhook URL"
          description={secretHint}
          value={s.teams.webhookUrl ?? ''}
          onChange={(e) => set('teams', { webhookUrl: empty(e.currentTarget.value) })}
        />
      </Card>
      <Card>
        <Group justify="space-between" mb="xs">
          <Title order={5}>Email</Title>
          <Button size="xs" variant="default" loading={test.isPending && test.variables === 'email'} onClick={() => test.mutate('email')}>
            Send a test to me
          </Button>
        </Group>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput
            label="SMTP URL"
            description="smtp://user:pass@host:587, as a secret reference. Default: the SMTP_URL setting of the platform"
            value={s.email.smtpUrl ?? ''}
            onChange={(e) => set('email', { smtpUrl: empty(e.currentTarget.value) })}
          />
          <TextInput
            label="From"
            placeholder="Asterius <platform@example.com>"
            value={s.email.from ?? ''}
            onChange={(e) => set('email', { from: empty(e.currentTarget.value) })}
          />
        </SimpleGrid>
      </Card>
      <Group>
        <Button loading={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
        <Text fz="sm" c="dimmed">
          People choose what they receive in their profile.
        </Text>
      </Group>
    </Stack>
  );
}

export function NotificationsAdmin() {
  const q = useQuery({ queryKey: ['notification-settings'], queryFn: api.notificationSettings });
  return (
    <Stack>
      <PageHeader title="Notifications" description="Default channels for the Slack, Teams and email steps, and for approval and run notifications." />
      <QueryView q={q}>{(s) => <Form initial={s} />}</QueryView>
    </Stack>
  );
}
