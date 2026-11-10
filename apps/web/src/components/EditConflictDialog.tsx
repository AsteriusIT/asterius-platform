import { useState } from 'react';
import { Alert, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconGitCompare } from '@tabler/icons-react';
import type { ActionVersionDiff, EditConflict } from '@asterius/shared';
import { errorText } from '../lib/api';
import { DiffView } from './builder/ActionHistory';
import { timeAgo } from './ui';

/** "Alice Martin changed this workflow 3 minutes ago (version 7)." */
export function conflictSummary(c: EditConflict, noun: string) {
  if (c.currentVersion === null) return `This ${noun} was deleted after you opened it.`;
  const who = c.changedBy?.name || c.changedBy?.email || 'Someone';
  const when = c.changedAt ? ` ${timeAgo(c.changedAt)}` : '';
  return `${who} changed this ${noun}${when} (version ${c.currentVersion}).`;
}

/**
 * Shown when a save is refused because someone else saved a newer version since the editor loaded it (412 with an
 * EditConflict, see conflictOf in lib/api). The user reloads their version (dropping their own edits), overwrites it
 * with theirs (history keeps the other version, so it is recoverable) or, when a diff is available, sees what changed.
 */
export function EditConflictDialog(props: {
  conflict: EditConflict | null;
  /** "workflow", "fragment", "entity"… */
  noun: string;
  onReload: () => unknown;
  onOverwrite: () => unknown;
  /** Keep editing (nothing saved). */
  onCancel: () => void;
  /** What changed between the version the editor loaded and the current one. */
  loadDiff?: (current: number) => Promise<ActionVersionDiff>;
}) {
  const c = props.conflict;
  const [busy, setBusy] = useState<'reload' | 'overwrite' | 'diff' | null>(null);
  const [diff, setDiff] = useState<ActionVersionDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (what: 'reload' | 'overwrite' | 'diff', fn: () => unknown) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
      if (what !== 'diff') setDiff(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  const close = () => {
    setDiff(null);
    setError(null);
    props.onCancel();
  };
  const gone = c?.currentVersion === null;
  return (
    <Modal opened={!!c} onClose={close} size="lg" title={<Text fw={600}>Someone else saved this {props.noun}</Text>}>
      {c && (
        <Stack>
          <Alert color="orange" variant="light" icon={<IconAlertTriangle size={18} />}>
            {conflictSummary(c, props.noun)} Your changes are not saved yet.
          </Alert>
          {diff && <DiffView diff={diff} />}
          {error && (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          )}
          <Group justify="space-between">
            <Group gap="xs">
              {props.loadDiff && !gone && !diff && (
                <Button
                  variant="subtle"
                  leftSection={<IconGitCompare size={14} />}
                  loading={busy === 'diff'}
                  onClick={() => void run('diff', async () => setDiff(await props.loadDiff!(c.currentVersion!)))}
                >
                  See their changes
                </Button>
              )}
            </Group>
            <Group gap="xs">
              <Button variant="default" onClick={close}>
                Cancel
              </Button>
              {!gone && (
                <Button variant="light" loading={busy === 'reload'} onClick={() => void run('reload', props.onReload)}>
                  Reload their version
                </Button>
              )}
              <Button color="orange" loading={busy === 'overwrite'} onClick={() => void run('overwrite', props.onOverwrite)}>
                {gone ? 'Recreate with mine' : 'Overwrite with mine'}
              </Button>
            </Group>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
