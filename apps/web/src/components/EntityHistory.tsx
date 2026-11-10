import { Badge, Button, Card, Code, Group, Stack, Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { EntityVersion } from '@asterius/shared';
import { api, errorText } from '../lib/api';
import { Empty, QueryView, TimeAgo } from './ui';
import { UserChip } from './UserChip';

const show = (v: unknown) => (v === null || v === undefined ? '∅' : typeof v === 'string' ? v : JSON.stringify(v));
const OP_COLORS: Record<EntityVersion['op'], string> = { create: 'green', update: 'blue', delete: 'red', revert: 'orange', restore: 'teal' };

/** History tab of an entity: one card per version with the field-level diff and a revert button. */
export function EntityHistory({ blueprint, identifier, canEdit }: { blueprint: string; identifier: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const history = useQuery({ queryKey: ['history', blueprint, identifier], queryFn: () => api.history(blueprint, identifier) });

  const revert = (v: EntityVersion) =>
    modals.openConfirmModal({
      title: `Revert to version ${v.version}?`,
      children: <Text fz="sm">The entity gets the state of version {v.version}. A new version is recorded; nothing is lost.</Text>,
      labels: { confirm: 'Revert', cancel: 'Cancel' },
      onConfirm: async () => {
        try {
          await api.revertEntity(blueprint, identifier, v.version);
          void qc.invalidateQueries({ queryKey: ['history', blueprint, identifier] });
          void qc.invalidateQueries({ queryKey: ['entity', blueprint, identifier] });
          void qc.invalidateQueries({ queryKey: ['related'] });
        } catch (err) {
          notifications.show({ color: 'red', message: errorText(err) });
        }
      },
    });

  return (
    <QueryView q={history}>
      {(h) =>
        h.items.length === 0 ? (
          <Empty title="No history yet" />
        ) : (
          <Stack>
            {h.items.map((v, i) => (
              <Card key={v.version}>
                <Group justify="space-between" mb="xs">
                  <Group gap="xs">
                    <Badge color={OP_COLORS[v.op]} variant="light">
                      {v.op}
                    </Badge>
                    <Text fw={500} fz="sm">
                      Version {v.version}
                    </Text>
                    <Text fz="sm" c="dimmed">
                      by {v.actor ? <UserChip user={v.actor} size="xs" /> : v.source} via {v.source} · <TimeAgo at={v.at} />
                    </Text>
                  </Group>
                  {canEdit && i > 0 && v.op !== 'delete' && (
                    <Button size="compact-xs" variant="default" onClick={() => revert(v)}>
                      Revert to this version
                    </Button>
                  )}
                </Group>
                {v.diff.length === 0 && (
                  <Text fz="sm" c="dimmed">
                    No field changes
                  </Text>
                )}
                <Stack gap="4xs">
                  {v.diff.map((d) => (
                    <Group key={d.path} gap="xs" wrap="nowrap" align="flex-start">
                      <Code>{d.path}</Code>
                      <Text fz="sm" c="red" td="line-through" className="wrap-anywhere">
                        {show(d.before)}
                      </Text>
                      <Text fz="sm" c="green" className="wrap-anywhere">
                        {show(d.after)}
                      </Text>
                    </Group>
                  ))}
                </Stack>
              </Card>
            ))}
          </Stack>
        )
      }
    </QueryView>
  );
}
