import { useState } from 'react';
import { ActionIcon, Button, Indicator, Stack, Switch, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { IconBell } from '@tabler/icons-react';
import { api, type NotificationItem } from '../lib/api';
import { useAppMutation } from '../lib/queryClient';
import { Empty, QueryView, TimeAgo } from './ui';
import { Section } from './Section';
import { SidePanel } from './SidePanel';

/** Bell with an unread badge and an inbox drawer: approvals to decide, run outcomes, plus email/Slack preferences. */
export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const inbox = useQuery({ queryKey: ['notifications'], queryFn: () => api.notifications({ limit: 50 }), refetchInterval: 30_000 });
  const prefs = useQuery({ queryKey: ['notification-prefs'], queryFn: api.notificationPrefs, enabled: open });
  const refresh = () => qc.invalidateQueries({ queryKey: ['notifications'] });
  const read = useAppMutation({ mutationFn: (body: { ids?: string[]; all?: boolean }) => api.markNotificationsRead(body), onSuccess: refresh });
  const savePrefs = useAppMutation({
    mutationFn: (p: { email: boolean; slack: boolean }) => api.saveNotificationPrefs(p),
    onSuccess: (p) => qc.setQueryData(['notification-prefs'], p),
  });
  const unread = inbox.data?.unread ?? 0;

  const openItem = (n: NotificationItem) => {
    if (!n.read) read.mutate({ ids: [n.id] });
    setOpen(false);
    if (n.link) void navigate(n.link);
  };

  return (
    <>
      <Tooltip label={unread ? `Notifications · ${unread} unread` : 'Notifications'}>
        <Indicator label={unread > 99 ? '99+' : unread} size={16} color="red" offset={5} disabled={!unread} inline>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="lg"
            onClick={() => setOpen(true)}
            aria-label={`Notifications${unread ? ` (${unread} unread)` : ''}`}
            data-tour="notifications"
          >
            <IconBell size={19} stroke={1.6} />
          </ActionIcon>
        </Indicator>
      </Tooltip>
      <SidePanel
        opened={open}
        onClose={() => setOpen(false)}
        width="narrow"
        title="Notifications"
        subtitle={unread ? `${unread} unread` : 'All caught up'}
        actions={
          <Button size="compact-sm" variant="subtle" disabled={!unread} onClick={() => read.mutate({ all: true })}>
            Mark all as read
          </Button>
        }
      >
        <QueryView q={inbox}>
          {(d) =>
            d.items.length === 0 ? (
              <Empty title="No notification yet">Approvals to decide and run outcomes appear here.</Empty>
            ) : (
              <Stack gap={2} role="list" aria-label="Notifications">
                {d.items.map((n) => (
                  <UnstyledButton
                    key={n.id}
                    role="listitem"
                    onClick={() => openItem(n)}
                    p="xs"
                    style={{ borderRadius: 'var(--mantine-radius-sm)', background: n.read ? undefined : 'var(--mantine-primary-color-light)' }}
                  >
                    <Text fz="sm" fw={n.read ? 400 : 600}>
                      {n.title}
                    </Text>
                    {n.body && (
                      <Text fz="xs" c="dimmed">
                        {n.body}
                      </Text>
                    )}
                    <Text fz="xs" c="dimmed">
                      <TimeAgo at={n.createdAt} />
                    </Text>
                  </UnstyledButton>
                ))}
              </Stack>
            )
          }
        </QueryView>
        <Section title="Also notify me by">
          <Stack gap="xs">
            <Switch
              label="Email"
              checked={prefs.data?.email ?? false}
              disabled={!prefs.data || savePrefs.isPending}
              onChange={(e) => prefs.data && savePrefs.mutate({ ...prefs.data, email: e.currentTarget.checked })}
            />
            <Switch
              label="Slack"
              checked={prefs.data?.slack ?? false}
              disabled={!prefs.data || savePrefs.isPending}
              onChange={(e) => prefs.data && savePrefs.mutate({ ...prefs.data, slack: e.currentTarget.checked })}
            />
            <Text fz="xs" c="dimmed">
              Preferences are saved now; email and Slack delivery start once those channels are configured on the platform.
            </Text>
          </Stack>
        </Section>
      </SidePanel>
    </>
  );
}
