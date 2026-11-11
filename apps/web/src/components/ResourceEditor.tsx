import { useState } from 'react';
import { Alert, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { parse, stringify } from 'yaml';
import { errorText } from '../lib/api';
import { CodeEditor } from './CodeEditor';
import { DialogFocus } from './dialogFocus';

/**
 * Edit any configurable resource as YAML (blueprints, actions, integrations, webhooks, teams): the same
 * format as the files of the configuration repository, so a resource can be copied to Git as is.
 */
export function ResourceEditor<T>(props: {
  title: string;
  /** Resource to edit, or a template for a new one; null closes the modal. */
  value: Record<string, unknown> | null;
  isNew: boolean;
  readOnly?: boolean;
  help?: React.ReactNode;
  /** Why the document is read-only (default: managed by the configuration repository). */
  readOnlyNotice?: React.ReactNode;
  onSave: (identifier: string, body: Record<string, unknown>) => Promise<T>;
  onClose: () => void;
}) {
  return (
    <Modal opened={!!props.value} onClose={props.onClose} title={<Text fw={600}>{props.title}</Text>} size="xl">
      {props.value && (
        <DialogFocus>
          <EditorBody {...props} value={props.value} />
        </DialogFocus>
      )}
    </Modal>
  );
}

function EditorBody<T>(props: {
  value: Record<string, unknown>;
  isNew: boolean;
  readOnly?: boolean;
  help?: React.ReactNode;
  readOnlyNotice?: React.ReactNode;
  onSave: (identifier: string, body: Record<string, unknown>) => Promise<T>;
  onClose: () => void;
}) {
  const [text, setText] = useState(() => stringify(props.value, { lineWidth: 120 }));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setError(null);
    let body: Record<string, unknown>;
    try {
      body = parse(text) as Record<string, unknown>;
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('The document must be a YAML mapping');
    } catch (e) {
      setError(`YAML: ${errorText(e)}`);
      return;
    }
    const id = String(body.identifier ?? '');
    if (!id) {
      setError('identifier is required');
      return;
    }
    if (!props.isNew && id !== props.value.identifier) {
      setError('The identifier cannot be changed; create a new resource instead');
      return;
    }
    setSaving(true);
    try {
      await props.onSave(id, body);
      notifications.show({ color: 'green', message: `${id} saved` });
      props.onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack>
      {props.readOnly && (
        <Alert color="grape" variant="light">
          {props.readOnlyNotice ?? 'Managed by the configuration repository: change it there. You can copy this YAML.'}
        </Alert>
      )}
      {props.help}
      <CodeEditor language="yaml" aria-label="YAML document" value={text} onChange={setText} minRows={16} maxRows={32} readOnly={props.readOnly} />
      {error && (
        <Alert color="red" variant="light" className="pre-wrap">
          {error}
        </Alert>
      )}
      <Group justify="flex-end">
        <Button variant="default" onClick={props.onClose}>
          {props.readOnly ? 'Close' : 'Cancel'}
        </Button>
        {!props.readOnly && (
          <Button onClick={save} loading={saving}>
            Save
          </Button>
        )}
      </Group>
    </Stack>
  );
}
