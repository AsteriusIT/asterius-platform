import { ActionIcon, Anchor, Avatar, CopyButton, Group, HoverCard, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { IconCheck, IconCopy, IconMail } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';

export interface UserRef {
  id?: string | null;
  name?: string | null;
  email?: string | null;
}

export const initials = (name = '') =>
  name
    .split(/[\s._@-]+/)
    .filter(Boolean)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

/**
 * A user shown by display name only, in a bordered pill; hovering (or focusing) it opens a card with the
 * avatar, name and email. A reference without an email (approvals, history) is completed from the user
 * directory, fetched only once a card is opened.
 */
export function UserChip({ user, size = 'sm' }: { user: UserRef | string | null | undefined; size?: 'xs' | 'sm' }) {
  const [opened, setOpened] = useState(false);
  const ref: UserRef = typeof user === 'string' ? (user.includes('@') ? { email: user } : { name: user }) : (user ?? {});
  const needsLookup = opened && !(ref.name && ref.email) && Boolean(ref.id || ref.email || ref.name);
  const lookup = useQuery({ queryKey: ['user-lookup'], queryFn: api.userLookup, staleTime: 60_000, enabled: needsLookup });
  const found = needsLookup
    ? lookup.data?.find((u) => (ref.id && u.id === ref.id) || (ref.email && u.email === ref.email) || (!ref.id && !ref.email && u.name === ref.name))
    : undefined;
  const name = ref.name || found?.name || ref.email || found?.email || 'Unknown user';
  const email = ref.email || found?.email || null;
  if (!user) {
    return (
      <Text span fz={size} c="dimmed">
        system
      </Text>
    );
  }
  const avatarSize = size === 'xs' ? 16 : 20;

  return (
    <HoverCard width={280} shadow="md" openDelay={250} closeDelay={100} withArrow position="bottom-start" onOpen={() => setOpened(true)}>
      <HoverCard.Target>
        <UnstyledButton
          aria-label={`User ${name}`}
          display="inline-flex"
          maw="100%"
          py={2}
          pl={2}
          pr={8}
          style={{ alignItems: 'center', gap: 6, border: '1px solid var(--mantine-color-default-border)', borderRadius: 999, verticalAlign: 'middle' }}
          onFocus={() => setOpened(true)}
        >
          <Avatar size={avatarSize} radius="xl" color="initials" name={name} fz={avatarSize * 0.45}>
            {initials(name)}
          </Avatar>
          <Text span fz={size} fw={500} truncate>
            {name}
          </Text>
        </UnstyledButton>
      </HoverCard.Target>
      <HoverCard.Dropdown>
        <Group wrap="nowrap" align="center">
          <Avatar size={44} radius="xl" color="initials" name={name}>
            {initials(name)}
          </Avatar>
          <Stack gap={2} miw={0}>
            <Text fw={600} truncate>
              {name}
            </Text>
            {email ? (
              <Group gap={4} wrap="nowrap">
                <IconMail size={14} style={{ flexShrink: 0, opacity: 0.6 }} />
                <Anchor href={`mailto:${email}`} fz="sm" truncate>
                  {email}
                </Anchor>
                <CopyButton value={email}>
                  {({ copied, copy }) => (
                    <Tooltip label={copied ? 'Copied' : 'Copy email'} withArrow>
                      <ActionIcon variant="subtle" color={copied ? 'teal' : 'gray'} size="sm" onClick={copy} aria-label="Copy email">
                        {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                      </ActionIcon>
                    </Tooltip>
                  )}
                </CopyButton>
              </Group>
            ) : (
              <Text fz="sm" c="dimmed">
                {lookup.isFetching ? 'Loading…' : 'No email on record'}
              </Text>
            )}
          </Stack>
        </Group>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}
