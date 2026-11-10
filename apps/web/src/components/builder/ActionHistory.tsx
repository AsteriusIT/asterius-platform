import { useState } from 'react';
import { Alert, Badge, Button, Code, Group, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconArrowBackUp, IconGitCompare } from '@tabler/icons-react';
import type { ActionVersionDiff } from '@asterius/shared';
import { api, errorText } from '../../lib/api';
import { QueryView, TimeAgo } from '../ui';
import { UserChip } from '../UserChip';

/** Version history of a workflow or a fragment: who changed it and when, a diff with the previous version, and rollback. */

export function DiffView({ diff }: { diff: ActionVersionDiff }) {
  const empty = !diff.fields.length && !diff.stepsAdded.length && !diff.stepsRemoved.length && !diff.stepsChanged.length && !diff.stepsReordered;
  if (empty) return <Text fz="sm">No difference.</Text>;
  const show = (v: unknown) => (v === undefined ? '(none)' : typeof v === 'string' ? v : JSON.stringify(v));
  return (
    <Stack gap={4}>
      {diff.fields.map((f) => (
        <Text key={f.path} fz="sm">
          <Code>{f.path}</Code>: {show(f.before).slice(0, 120)} → {show(f.after).slice(0, 120)}
        </Text>
      ))}
      {diff.stepsAdded.map((id) => (
        <Text key={`+${id}`} fz="sm" c="green">
          + step <Code>{id}</Code>
        </Text>
      ))}
      {diff.stepsRemoved.map((id) => (
        <Text key={`-${id}`} fz="sm" c="red">
          − step <Code>{id}</Code>
        </Text>
      ))}
      {diff.stepsChanged.map((s) => (
        <Text key={s.id} fz="sm">
          step <Code>{s.id}</Code> changed: {s.changes.map((c) => c.path).join(', ')}
        </Text>
      ))}
      {diff.stepsReordered && <Text fz="sm">Steps were reordered.</Text>}
    </Stack>
  );
}

interface HistoryVersion {
  version: number;
  actor: string | null;
  at: string;
  note?: string | null;
}

export function VersionHistory(props: {
  queryKey: unknown[];
  list: () => Promise<HistoryVersion[]>;
  diff: (from: number, to: number) => Promise<ActionVersionDiff>;
  restore: (version: number) => Promise<unknown>;
  /** The live version (default: the newest one). */
  current?: number;
  intro: string;
  onRestored: () => void;
  readOnly?: boolean;
}) {
  const qc = useQueryClient();
  const versions = useQuery({ queryKey: props.queryKey, queryFn: props.list });
  const [shown, setShown] = useState<{ version: number; diff: ActionVersionDiff } | null>(null);
  const compare = useMutation({
    mutationFn: (version: number) => props.diff(version - 1, version),
    onSuccess: (diff, version) => setShown({ version, diff }),
    onError: (e) => notifications.show({ color: 'red', message: errorText(e) }),
  });
  const restore = useMutation({
    mutationFn: props.restore,
    onSuccess: () => {
      void qc.invalidateQueries();
      props.onRestored();
    },
    onError: (e) => notifications.show({ color: 'red', message: errorText(e) }),
  });
  return (
    <QueryView q={versions}>
      {(list) => {
        const current = props.current ?? list[0]?.version;
        return (
          <Stack gap="xs">
            <Alert color="gray" variant="light">
              {props.intro}
            </Alert>
            {list.map((v) => (
              <Stack key={v.version} gap={4}>
                <Group justify="space-between">
                  <Group gap="xs">
                    <Badge variant={v.version === current ? 'filled' : 'light'}>v{v.version}</Badge>
                    <UserChip user={v.actor} />
                    <Text fz="xs" c="dimmed">
                      <TimeAgo at={v.at} />
                      {v.note ? ` · ${v.note}` : ''}
                    </Text>
                  </Group>
                  <Group gap="xs">
                    {v.version > 1 && (
                      <Button
                        size="xs"
                        variant="default"
                        leftSection={<IconGitCompare size={14} />}
                        loading={compare.isPending && compare.variables === v.version}
                        onClick={() => compare.mutate(v.version)}
                      >
                        Changes
                      </Button>
                    )}
                    {v.version !== current && !props.readOnly && (
                      <Button
                        size="xs"
                        variant="light"
                        leftSection={<IconArrowBackUp size={14} />}
                        loading={restore.isPending && restore.variables === v.version}
                        onClick={() => restore.mutate(v.version)}
                      >
                        Restore
                      </Button>
                    )}
                  </Group>
                </Group>
                {shown?.version === v.version && <DiffView diff={shown.diff} />}
              </Stack>
            ))}
          </Stack>
        );
      }}
    </QueryView>
  );
}

export function ActionHistory({ identifier, current, onRestored }: { identifier: string; current: number; onRestored: () => void }) {
  return (
    <VersionHistory
      queryKey={['action-versions', identifier]}
      list={() => api.actionVersions(identifier)}
      diff={(from, to) => api.actionDiff(identifier, from, to)}
      restore={(version) => api.rollbackAction(identifier, version)}
      current={current}
      intro="Every change creates a version; runs record the version they started from. Restoring creates a new version with the old definition."
      onRestored={onRestored}
    />
  );
}

export function FragmentHistory({ identifier, readOnly, onRestored }: { identifier: string; readOnly?: boolean; onRestored: () => void }) {
  return (
    <VersionHistory
      queryKey={['fragment-versions', identifier]}
      list={() => api.fragmentVersions(identifier)}
      diff={(from, to) => api.fragmentDiff(identifier, from, to)}
      restore={(version) => api.rollbackFragment(identifier, version)}
      intro="Every change creates a version; runs keep the copy of the steps they started with. Restoring creates a new version with the old definition, checked against the workflows using it."
      onRestored={onRestored}
      readOnly={readOnly}
    />
  );
}
