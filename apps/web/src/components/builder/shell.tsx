import { useState, type ReactNode } from 'react';
import { Alert, Box, Button, Group, JsonInput, Modal, ScrollArea, Stack, Tabs, Text, Textarea } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { parse, stringify } from 'yaml';
import { IconAlertTriangle, IconBraces, IconCode } from '@tabler/icons-react';
import { errorText } from '../../lib/api';
import { MONO_INPUT } from './blocks';

/**
 * The frame shared by the builders (actions, blueprints): large dialog with overlay scrollbars, builder tabs
 * plus JSON / YAML views of the same document, problem list and a footer that stays visible while scrolling.
 */

/** "Request a database" → "request-a-database" */
export const slugify = (title: string) =>
  title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .slice(0, 64);

export function BuilderModal({ opened, onClose, title, children }: { opened: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const mobile = useMediaQuery('(max-width: 48em)');
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size="76rem"
      fullScreen={mobile}
      title={<Text fw={600}>{title}</Text>}
      scrollAreaComponent={ScrollArea.Autosize}
      // The footer is sticky inside the body: no bottom padding under it.
      styles={{ body: { paddingBottom: 0 } }}
    >
      {children}
    </Modal>
  );
}

/** JSON / YAML text of the document, parsed back on every keystroke. */
export function useCodeView(opts: { body: () => Record<string, unknown>; replace: (doc: Record<string, unknown>) => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  return {
    text,
    error,
    /** Call when a tab opens: fills the editor for code tabs. */
    open(tab: string | null) {
      if (tab === 'json') setText(JSON.stringify(opts.body(), null, 2));
      if (tab === 'yaml') setText(stringify(opts.body(), { lineWidth: 120 }));
      setError(null);
    },
    change(t: string, format: 'json' | 'yaml') {
      setText(t);
      try {
        const parsed = format === 'json' ? JSON.parse(t) : parse(t);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The document must be an object');
        opts.replace(parsed as Record<string, unknown>);
        setError(null);
      } catch (e) {
        setError(errorText(e));
      }
    },
  };
}
export type CodeView = ReturnType<typeof useCodeView>;

export function CodeTabs() {
  return (
    <>
      <Tabs.Tab value="json" leftSection={<IconBraces size={16} />} ml="auto">
        JSON
      </Tabs.Tab>
      <Tabs.Tab value="yaml" leftSection={<IconCode size={16} />}>
        YAML
      </Tabs.Tab>
    </>
  );
}

export function CodePanels({ view, readOnly }: { view: CodeView; readOnly?: boolean }) {
  return (
    <>
      <Tabs.Panel value="json">
        <JsonInput
          value={view.text}
          onChange={(t) => view.change(t, 'json')}
          autosize
          minRows={18}
          error={view.error}
          readOnly={readOnly}
          styles={MONO_INPUT}
          fz="xs"
        />
      </Tabs.Panel>
      <Tabs.Panel value="yaml">
        <Textarea
          value={view.text}
          onChange={(e) => view.change(e.currentTarget.value, 'yaml')}
          autosize
          minRows={18}
          error={view.error}
          readOnly={readOnly}
          styles={MONO_INPUT}
          fz="xs"
          spellCheck={false}
        />
      </Tabs.Panel>
    </>
  );
}

export function ManagedNotice() {
  return (
    <Alert color="grape" variant="light">
      Managed by the configuration repository (CONFIG_DIR): change it there. The JSON / YAML tabs show the document to copy.
    </Alert>
  );
}

/** Problems + Cancel / Save, stuck to the bottom of the dialog while the content scrolls. */
export function BuilderFooter(props: { problems: string[]; readOnly?: boolean; saving: boolean; saveLabel: string; onSave: () => void; onClose: () => void }) {
  return (
    <Box pos="sticky" bottom={0} pt="sm" pb="lg" mt="md" style={{ background: 'var(--mantine-color-body)', borderTop: '1px solid var(--hairline)', zIndex: 2 }}>
      <Stack gap="sm">
        {props.problems.length > 0 && (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />} title="Fix these before saving">
            <Stack gap={2}>
              {props.problems.map((p) => (
                <Text key={p} fz="sm">
                  {p}
                </Text>
              ))}
            </Stack>
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={props.onClose}>
            {props.readOnly ? 'Close' : 'Cancel'}
          </Button>
          {!props.readOnly && (
            <Button onClick={props.onSave} loading={props.saving}>
              {props.saveLabel}
            </Button>
          )}
        </Group>
      </Stack>
    </Box>
  );
}

/** Save with client-side checks first; server errors land in the same list. */
export function useSave(onSave: () => Promise<unknown>, onClose: () => void) {
  const [problems, setProblems] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  return {
    problems,
    saving,
    async save(found: string[]) {
      setProblems(found);
      if (found.length) return;
      setSaving(true);
      try {
        await onSave();
        onClose();
      } catch (e) {
        setProblems([errorText(e)]);
      } finally {
        setSaving(false);
      }
    },
  };
}

/** Disables every input of read-only (managed) resources. */
export function ReadOnlyFieldset({ readOnly, children }: { readOnly?: boolean; children: ReactNode }) {
  return (
    <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      {children}
    </fieldset>
  );
}
