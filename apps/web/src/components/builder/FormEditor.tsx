import { useState, type ReactNode } from 'react';
import { Alert, Button, Group, Modal, Stack, Tabs, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { parse, stringify } from 'yaml';
import { errorText } from '../../lib/api';
import { CodeEditor } from '../CodeEditor';

export type Doc = Record<string, unknown>;

/**
 * Modal editor with a form tab (rendered by the caller) and a YAML tab over the same document, so any resource
 * can be built from a form and still be copied to the configuration repository as YAML.
 */
export function FormEditor(props: {
  title: string;
  value: Doc | null;
  isNew: boolean;
  readOnly?: boolean;
  /** The form: receives the document and a patch function. */
  form: (doc: Doc, patch: (p: Doc) => void) => ReactNode;
  onSave: (identifier: string, body: Doc) => Promise<unknown>;
  onClose: () => void;
}) {
  return (
    <Modal opened={!!props.value} onClose={props.onClose} title={<Text fw={600}>{props.title}</Text>} size="xl">
      {props.value && <Body {...props} value={props.value} />}
    </Modal>
  );
}

function Body(props: {
  value: Doc;
  isNew: boolean;
  readOnly?: boolean;
  form: (doc: Doc, patch: (p: Doc) => void) => ReactNode;
  onSave: (identifier: string, body: Doc) => Promise<unknown>;
  onClose: () => void;
}) {
  const [doc, setDoc] = useState<Doc>(props.value);
  const [tab, setTab] = useState<string>('form');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const parseText = (): Doc | null => {
    try {
      const body = parse(text) as unknown;
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('The document must be a YAML mapping');
      return body as Doc;
    } catch (e) {
      setError(`YAML: ${errorText(e)}`);
      return null;
    }
  };
  const switchTab = (t: string | null) => {
    if (!t || t === tab) return;
    setError(null);
    if (t === 'yaml') setText(stringify(doc, { lineWidth: 120 }));
    else {
      const parsed = parseText();
      if (!parsed) return; // stay on YAML until it parses
      setDoc(parsed);
    }
    setTab(t);
  };

  const save = async () => {
    setError(null);
    const body = tab === 'yaml' ? parseText() : doc;
    if (!body) return;
    const id = String(body.identifier ?? '');
    if (!id) return setError('identifier is required');
    if (!props.isNew && id !== props.value.identifier) return setError('The identifier cannot be changed; create a new resource instead');
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
          Managed by the configuration repository: change it there. You can copy this YAML.
        </Alert>
      )}
      <Tabs value={tab} onChange={switchTab}>
        <Tabs.List mb="md">
          <Tabs.Tab value="form">Form</Tabs.Tab>
          <Tabs.Tab value="yaml">YAML</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="form">
          <fieldset disabled={props.readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            {props.form(doc, (p) => setDoc((d) => ({ ...d, ...p })))}
          </fieldset>
        </Tabs.Panel>
        <Tabs.Panel value="yaml">
          <CodeEditor language="yaml" aria-label="YAML document" value={text} onChange={setText} minRows={16} maxRows={32} readOnly={props.readOnly} />
        </Tabs.Panel>
      </Tabs>
      {error && (
        <Alert color="red" variant="light" style={{ whiteSpace: 'pre-wrap' }}>
          {error}
        </Alert>
      )}
      <Group justify="flex-end">
        <Button variant="default" onClick={props.onClose}>
          {props.readOnly ? 'Close' : 'Cancel'}
        </Button>
        {!props.readOnly && (
          <Button onClick={() => void save()} loading={saving}>
            Save
          </Button>
        )}
      </Group>
    </Stack>
  );
}
