import { useState, type ReactNode } from 'react';
import { Badge, SimpleGrid, Stack, Tabs, TextInput } from '@mantine/core';
import type { ActionVersionDiff, EditConflict } from '@asterius/shared';
import { conflictOf } from '../../lib/api';
import { EditConflictDialog } from '../EditConflictDialog';
import { MONO_INPUT } from './blocks';
import { BuilderFooter, BuilderModal, CodePanels, CodeTabs, ManagedNotice, ReadOnlyFieldset, slugify, useCodeView, useSave } from './shell';

/**
 * Generic form dialog for a configurable resource (integrations, webhooks, teams): tabs of form fields plus the
 * JSON / YAML views of the same document, so a resource can still be copied to the configuration repository.
 */

export type EditorProps = {
  value: Record<string, unknown> | null;
  isNew: boolean;
  readOnly?: boolean;
  /** `ifMatch`: the version the editor loaded (versioned resources; a newer stored version refuses the save with 412). */
  onSave: (identifier: string, body: Record<string, unknown>, opts?: { ifMatch?: number }) => Promise<unknown>;
  onClose: () => void;
};

/**
 * Optimistic concurrency of a versioned resource (fragments): `value.version` is the version loaded, sent back with
 * the save; when someone saved a newer one meanwhile the EditConflictDialog offers to reload it or overwrite it.
 */
export interface Versioned {
  /** The current stored document (with its `version`), for "Reload their version". */
  reload: (identifier: string) => Promise<Record<string, unknown>>;
  /** What changed between two versions, for "See their changes". */
  diff?: (identifier: string, from: number, to: number) => Promise<ActionVersionDiff>;
}

const versionOf = (v: Record<string, unknown>) => (typeof v.version === 'number' ? v.version : undefined);
const withoutVersion = (v: Record<string, unknown>) => {
  const { version: _, ...rest } = v;
  return rest;
};

export const SLUG = /^[a-z][a-z0-9_-]{0,63}$/;

export type Doc = Record<string, unknown> & { identifier: string; title: string };

export interface FormContext<D extends Doc> {
  doc: D;
  set: (patch: Partial<D>) => void;
  isNew: boolean;
  readOnly?: boolean;
}

export interface FormTab<D extends Doc> {
  value: string;
  label: string;
  icon: ReactNode;
  count?: (doc: D) => number;
  render: (ctx: FormContext<D>) => ReactNode;
}

/** Problems shared by every resource: identifier and title. */
export function identityProblems(doc: Doc): string[] {
  const out: string[] = [];
  if (!doc.title.trim()) out.push('Title is required');
  if (!SLUG.test(doc.identifier)) out.push('Identifier: lowercase letters, digits, - and _, starting with a letter');
  return out;
}

export function FormBuilder<D extends Doc>(
  props: EditorProps & {
    /** "integration", "webhook"… for the title and save button. */
    noun: string;
    toDoc: (v: Record<string, unknown>) => D;
    /** Document sent to the API (defaults to the doc itself). */
    toBody?: (doc: D) => Record<string, unknown>;
    problems: (doc: D) => string[];
    tabs: FormTab<D>[];
    size?: string;
    header?: ReactNode;
    versioned?: Versioned;
  },
) {
  const title = props.isNew ? `New ${props.noun}` : `${props.readOnly ? 'View' : 'Edit'} ${String(props.value?.identifier ?? '')}`;
  return (
    <BuilderModal opened={!!props.value} onClose={props.onClose} title={title} size={props.size}>
      {props.value && <Body {...props} value={props.value} />}
    </BuilderModal>
  );
}

function Body<D extends Doc>(props: Parameters<typeof FormBuilder<D>>[0] & { value: Record<string, unknown> }) {
  const { isNew, readOnly, versioned } = props;
  const [doc, setDoc] = useState<D>(() => props.toDoc(versioned ? withoutVersion(props.value) : props.value));
  const [base, setBase] = useState(() => (versioned ? versionOf(props.value) : undefined));
  const [conflict, setConflict] = useState<EditConflict | null>(null);
  const [tab, setTab] = useState<string | null>(props.tabs[0].value);
  // Remount the form after a JSON / YAML edit so uncontrolled sub-editors (key/value rows…) reload.
  const [generation, setGeneration] = useState(0);
  const set = (patch: Partial<D>) => setDoc((d) => ({ ...d, ...patch }));
  const body = () => (props.toBody ?? ((d: D) => d as Record<string, unknown>))(doc);
  const code = useCodeView({
    body,
    replace: (parsed) => {
      const next = props.toDoc(parsed);
      if (!isNew) next.identifier = doc.identifier;
      setDoc(next);
      setGeneration((g) => g + 1);
    },
  });
  const saver = useSave(
    () => (base === undefined ? props.onSave(doc.identifier, body()) : props.onSave(doc.identifier, body(), { ifMatch: base })),
    props.onClose,
    (e) => {
      const c = conflictOf(e);
      if (c) setConflict(c);
      return !!c;
    },
  );
  /** After a conflict: drop my edits and continue from their version. */
  const reload = async () => {
    const fresh = await versioned!.reload(doc.identifier);
    setDoc(props.toDoc(withoutVersion(fresh)));
    setBase(versionOf(fresh));
    setGeneration((g) => g + 1);
    if (tab === 'json' || tab === 'yaml') setTab(props.tabs[0].value); // the code text would show my version
    setConflict(null);
  };
  const save = () => {
    const found = props.problems(doc);
    if (code.error && (tab === 'json' || tab === 'yaml')) found.unshift(`${tab.toUpperCase()}: ${code.error}`);
    void saver.save(found);
  };
  const ctx: FormContext<D> = { doc, set, isNew, readOnly };

  return (
    <Stack>
      {readOnly && <ManagedNotice />}
      {props.header}
      <Tabs
        value={tab}
        onChange={(t) => {
          code.open(t);
          setTab(t);
        }}
        keepMounted={false}
      >
        <Tabs.List mb="md">
          {props.tabs.map((t) => {
            const n = t.count?.(doc);
            return (
              <Tabs.Tab key={t.value} value={t.value} leftSection={t.icon} rightSection={n ? <Badge size="xs">{n}</Badge> : undefined}>
                {t.label}
              </Tabs.Tab>
            );
          })}
          <CodeTabs />
        </Tabs.List>
        <ReadOnlyFieldset readOnly={readOnly} key={generation}>
          {props.tabs.map((t) => (
            <Tabs.Panel key={t.value} value={t.value}>
              {t.render(ctx)}
            </Tabs.Panel>
          ))}
        </ReadOnlyFieldset>
        <CodePanels view={code} readOnly={readOnly} />
      </Tabs>
      <BuilderFooter
        problems={saver.problems}
        readOnly={readOnly}
        saving={saver.saving}
        saveLabel={isNew ? `Create ${props.noun}` : 'Save'}
        onSave={save}
        onClose={props.onClose}
      />
      {versioned && (
        <EditConflictDialog
          conflict={conflict}
          noun={props.noun}
          onReload={reload}
          onOverwrite={async () => {
            await props.onSave(doc.identifier, body());
            setConflict(null);
            props.onClose();
          }}
          onCancel={() => setConflict(null)}
          loadDiff={versioned.diff && base !== undefined ? (current) => versioned.diff!(doc.identifier, base, current) : undefined}
        />
      )}
    </Stack>
  );
}

/** Title + identifier; while creating, the identifier follows the title until edited by hand. */
export function IdentityFields<D extends Doc>({ doc, set, isNew, placeholder }: FormContext<D> & { placeholder: string }) {
  const [touched, setTouched] = useState(!isNew || !!doc.identifier);
  return (
    <SimpleGrid cols={{ base: 1, sm: 2 }}>
      <TextInput
        label="Title"
        withAsterisk
        placeholder={placeholder}
        value={doc.title}
        onChange={(e) => {
          const t = e.currentTarget.value;
          set((isNew && !touched ? { title: t, identifier: slugify(t) } : { title: t }) as Partial<D>);
        }}
      />
      <TextInput
        label="Identifier"
        withAsterisk
        description={isNew ? 'From the title; used in URLs and the API, cannot be changed later' : 'Cannot be changed'}
        disabled={!isNew}
        placeholder={slugify(placeholder)}
        value={doc.identifier}
        onChange={(e) => {
          setTouched(true);
          set({ identifier: e.currentTarget.value } as Partial<D>);
        }}
        error={doc.identifier && !SLUG.test(doc.identifier) ? 'lowercase, digits, - and _' : undefined}
        styles={MONO_INPUT}
      />
    </SimpleGrid>
  );
}
