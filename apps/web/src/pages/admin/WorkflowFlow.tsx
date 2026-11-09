import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActionIcon, Alert, Badge, Button, Code, Group, Menu, Modal, NumberInput, Stack, Switch, Tabs, TagsInput, Text, Tooltip } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, useParams } from 'react-router';
import { IconCode, IconDeviceFloppy, IconFlask, IconHistory, IconPlus, IconSettings, IconTestPipe, IconTrash, IconX } from '@tabler/icons-react';
import type { Action, BlackoutWindow, DryRunResult, DryRunStep, WorkflowStep, WorkflowStepType, WorkflowTest } from '@asterius/shared';
import { api, errorText } from '../../lib/api';
import { connectSteps, disconnectSteps, insertStepAfter, needsOf, STEP_TYPES, stepWarnings, type FlowTone } from '../../lib/workflow';
import { QueryView } from '../../components/ui';
import { FlowShell } from '../../components/FlowShell';
import { JsonBlock } from '../../components/CodeEditor';
import { StepTypeItems, TRIGGER_ID, WorkflowFlow, type FlowStep, type FlowTrigger } from '../../components/WorkflowFlow';
import { docProblems, GeneralFields, RunOptionsFields, toActionDoc, type ActionDoc } from '../../components/builder/ActionBuilder';
import { newStep, patchStep, StepSettings } from '../../components/builder/WorkflowEditor';
import { isFormLike, newFormTrigger, TriggerEditor, TRIGGER_TYPES, triggerSummary } from '../../components/builder/TriggerEditor';
import { fieldsToSchema, schemaToFields, type FieldDraft } from '../../components/builder/fields';
import { DryRunModal } from '../../components/builder/DryRunModal';
import { ActionHistory } from '../../components/builder/ActionHistory';
import { WorkflowTests } from '../../components/builder/WorkflowTests';
import { CodePanels, CodeTabs, useCodeView } from '../../components/builder/shell';
import { AiDraft, JsonPreview } from '../../components/AiAssistant';

/**
 * The workflow editor (/admin/actions/:id): the workflow as a graph filling the content panel. Nodes open their
 * settings in a dialog, dragging from a node's right handle to another node adds a dependency (select a link and press
 * Delete to remove it), "+" on a node adds a step after it. The floating buttons open the general settings, the
 * JSON / YAML document, the version history and the test, which is drawn on the graph: green would run, grey
 * skipped, red has errors. Managed workflows (configuration repository) open read-only.
 */

type Editing = { kind: 'trigger' } | { kind: 'step'; id: string } | { kind: 'general' } | { kind: 'code' } | { kind: 'history' } | { kind: 'tests' } | null;

const TEST_TONE: Record<DryRunStep['status'], FlowTone> = { planned: 'success', skipped: 'skipped', error: 'failure' };

export function WorkflowFlowPage() {
  const { id = '' } = useParams();
  const q = useQuery({ queryKey: ['action', id], queryFn: () => api.action(id) });
  return (
    <QueryView q={q}>
      {(a) => {
        const { managed, allowedForMe: _, ...value } = a as typeof a & { allowedForMe?: unknown; version?: number };
        const version = typeof value.version === 'number' ? value.version : undefined;
        // A restored version remounts the editor on it.
        return <FlowEditor key={`${id}:${version ?? ''}`} value={value} readOnly={managed} version={version} />;
      }}
    </QueryView>
  );
}

/** The former URL of the editor. */
export function WorkflowFlowRedirect() {
  const { id = '' } = useParams();
  return <Navigate to={`/admin/actions/${encodeURIComponent(id)}`} replace />;
}

function FlowEditor({ value, readOnly, version }: { value: Record<string, unknown>; readOnly: boolean; version?: number }) {
  const qc = useQueryClient();
  const meta = useQuery({ queryKey: ['meta'], queryFn: api.meta, staleTime: Infinity });
  const invokers = useMemo(() => meta.data?.invokers ?? [], [meta.data]);
  const [doc, setDoc] = useState<ActionDoc>(() => toActionDoc(value));
  const [fields, setFields] = useState<FieldDraft[]>(() => {
    const t = toActionDoc(value).trigger;
    return schemaToFields(isFormLike(t) ? t.inputs : { properties: {} });
  });
  const [dirty, setDirty] = useState(false);
  const [codeTab, setCodeTab] = useState<string | null>('json');
  const [editing, setEditing] = useState<Editing>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<DryRunResult | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  // Closing the tab with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const change = useCallback((patch: Partial<ActionDoc>) => {
    setDoc((d) => ({ ...d, ...patch }));
    setDirty(true);
    setTest(null); // the drawn test no longer matches the workflow
  }, []);
  const setSteps = useCallback((f: (steps: WorkflowStep[]) => WorkflowStep[] | null) => {
    setDoc((d) => {
      const steps = f(d.steps);
      return steps ? { ...d, steps } : d;
    });
    setDirty(true);
    setTest(null);
  }, []);
  const setFieldDrafts = (f: FieldDraft[]) => {
    setFields(f);
    setDirty(true);
    setTest(null);
  };

  const body = useCallback(
    (): Record<string, unknown> => ({ ...doc, trigger: isFormLike(doc.trigger) ? { ...doc.trigger, inputs: fieldsToSchema(fields) } : doc.trigger }),
    [doc, fields],
  );

  const code = useCodeView({
    body,
    replace: (parsed) => {
      const next = toActionDoc(parsed);
      next.identifier = doc.identifier;
      setDoc(next);
      setFields(schemaToFields(isFormLike(next.trigger) ? next.trigger.inputs : { properties: {} }));
      setDirty(true);
      setTest(null);
    },
  });
  const openCode = () => {
    code.open(codeTab);
    setEditing({ kind: 'code' });
  };

  const save = async () => {
    const found = docProblems(doc, fields, invokers);
    setProblems(found);
    if (found.length) return;
    setSaving(true);
    try {
      await api.saveAction(doc.identifier, body());
      setDirty(false);
      notifications.show({ color: 'green', message: `Workflow ${doc.identifier} saved` });
      void qc.invalidateQueries({ queryKey: ['admin-actions'] });
      void qc.invalidateQueries({ queryKey: ['action', doc.identifier] });
    } catch (e) {
      setProblems([errorText(e)]);
    } finally {
      setSaving(false);
    }
  };

  const add = useCallback(
    (after: string | null, type: WorkflowStepType) => {
      const s = newStep(type, doc.steps, invokers);
      setSteps((steps) => insertStepAfter(steps, after === TRIGGER_ID ? null : after, s));
      setEditing({ kind: 'step', id: s.id });
    },
    [doc.steps, invokers, setSteps],
  );
  const connect = useCallback(
    (source: string, target: string) =>
      setSteps((steps) => {
        const next = connectSteps(steps, source, target);
        if (!next) notifications.show({ color: 'red', message: `"${target}" cannot wait for "${source}": it would create a loop.` });
        return next;
      }),
    [setSteps],
  );
  const disconnect = useCallback((source: string, target: string) => setSteps((steps) => disconnectSteps(steps, source, target)), [setSteps]);

  const testOf = useMemo(() => new Map((test?.steps ?? []).map((s) => [s.id, s])), [test]);
  const flowSteps: FlowStep[] = useMemo(
    () =>
      doc.steps.map((s, i) => {
        const t = testOf.get(s.id);
        return {
          id: s.id,
          name: s.name,
          type: s.type,
          needs: needsOf(doc.steps, i),
          tone: t ? TEST_TONE[t.status] : undefined,
          detail: t?.errors.length ? `${t.errors.length} problem${t.errors.length > 1 ? 's' : ''}` : t?.status === 'skipped' ? 'condition is false' : null,
          badges: [...(s.if ? ['if'] : []), ...(s.retries ? [`${s.retries} retries`] : []), ...(s.continueOnError ? ['may fail'] : [])],
        };
      }),
    [doc.steps, testOf],
  );
  const form = isFormLike(doc.trigger) ? doc.trigger : null;
  const trigger: FlowTrigger | null = useMemo(
    () =>
      doc.trigger
        ? {
            title: TRIGGER_TYPES[doc.trigger.type].label,
            subtitle: triggerSummary(doc.trigger),
            tone: test ? (test.inputErrors.length ? 'failure' : 'success') : undefined,
            badges: [
              ...(form && fields.length ? [`${fields.length} field${fields.length > 1 ? 's' : ''}`] : []),
              ...(form?.approval.required ? ['approval'] : []),
            ],
          }
        : null,
    [doc.trigger, form, fields.length, test],
  );

  const stepIndex = editing?.kind === 'step' ? doc.steps.findIndex((s) => s.id === editing.id) : -1;
  const step = stepIndex >= 0 ? doc.steps[stepIndex]! : null;
  const triggerBlueprint = doc.trigger && 'blueprint' in doc.trigger ? (doc.trigger.blueprint ?? null) : null;
  const onEntity = !!form && form.on !== 'create' && !!form.blueprint;
  const warnings = useMemo(() => stepWarnings(doc.steps), [doc.steps]);
  const missing = [...(doc.trigger ? [] : ['a trigger']), ...(doc.steps.length ? [] : ['a step'])];

  const removeStep = () => {
    if (!step) return;
    setSteps((steps) => steps.filter((s) => s.id !== step.id).map((s) => (s.needs ? { ...s, needs: s.needs.filter((n) => n !== step.id) } : s)));
    setEditing(null);
  };
  const removeTrigger = () =>
    modals.openConfirmModal({
      title: 'Remove the trigger?',
      children: <Text fz="sm">Its form fields are removed too. Without a trigger, the workflow cannot be started.</Text>,
      labels: { confirm: 'Remove', cancel: 'Keep' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        change({ trigger: null });
        setFields([]);
        setEditing(null);
      },
    });

  return (
    <>
      <FlowShell
        back={{ to: '/admin/actions', label: 'Back to workflows' }}
        title={doc.title || doc.identifier}
        meta={
          <>
            {readOnly && (
              <Tooltip label="Managed by the configuration repository (CONFIG_DIR): change it there">
                <Badge size="xs" variant="light" color="gray">
                  Read-only
                </Badge>
              </Tooltip>
            )}
            {dirty && (
              <Badge size="xs" variant="light" color="orange">
                Unsaved changes
              </Badge>
            )}
          </>
        }
        actions={
          <>
            {!readOnly && !doc.trigger && (
              <Button
                size="xs"
                variant="default"
                leftSection={<IconPlus size={14} />}
                onClick={() => {
                  change({ trigger: newFormTrigger() });
                  setFields([]);
                  setEditing({ kind: 'trigger' });
                }}
              >
                Add a trigger
              </Button>
            )}
            {!readOnly && (
              <Menu position="bottom-end" width={320}>
                <Menu.Target>
                  <Button size="xs" variant="default" leftSection={<IconPlus size={14} />}>
                    Add a step
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  <StepTypeItems onPick={(t) => add(doc.steps.at(-1)?.id ?? null, t)} />
                </Menu.Dropdown>
              </Menu>
            )}
            {!readOnly && doc.steps.length === 0 && (
              <AiDraft
                label="Draft steps with AI"
                title="Draft a workflow"
                help="Describe what the workflow should do. The draft replaces the (empty) step list; review and adjust it before saving. Drafts never include write tools or credentials."
                placeholder="When someone requests a database, have an AI review the request, ask the platform team to approve, then call our provisioning webhook."
                run={(text) => api.aiDraftWorkflow(text)}
                preview={(d) => <JsonPreview value={d.steps} />}
                onDraft={(d) => setSteps(() => d.steps)}
              />
            )}
            <Button size="xs" variant="default" leftSection={<IconSettings size={14} />} onClick={() => setEditing({ kind: 'general' })}>
              General
            </Button>
            <Tooltip label="Edit as JSON / YAML">
              <ActionIcon size={30} variant="default" onClick={openCode} aria-label="Code">
                <IconCode size={16} />
              </ActionIcon>
            </Tooltip>
            {version !== undefined && !readOnly && (
              <Tooltip label="Version history">
                <ActionIcon size={30} variant="default" onClick={() => setEditing({ kind: 'history' })} aria-label="History">
                  <IconHistory size={16} />
                </ActionIcon>
              </Tooltip>
            )}
            <Button size="xs" variant="light" leftSection={<IconFlask size={14} />} onClick={() => setTesting(true)} disabled={!doc.steps.length}>
              Test
            </Button>
            <Button size="xs" variant="default" leftSection={<IconTestPipe size={14} />} onClick={() => setEditing({ kind: 'tests' })}>
              Tests{(doc.tests as WorkflowTest[] | undefined)?.length ? ` (${(doc.tests as WorkflowTest[]).length})` : ''}
            </Button>
            {!readOnly && (
              <Button size="xs" leftSection={<IconDeviceFloppy size={14} />} loading={saving} onClick={() => void save()}>
                Save
              </Button>
            )}
          </>
        }
        banner={
          (problems.length > 0 || (missing.length > 0 && !readOnly) || test) && (
            <>
              {problems.length > 0 && (
                <Alert color="red" title="Not saved" withCloseButton onClose={() => setProblems([])}>
                  {problems.map((p) => (
                    <Text key={p} fz="sm">
                      {p}
                    </Text>
                  ))}
                </Alert>
              )}
              {missing.length > 0 && !readOnly && (
                <Alert color="gray">Draft: add {missing.join(' and ')} so users can run it. Hover a node and click + to add the step after it.</Alert>
              )}
              {test && (
                <Alert
                  color={test.valid ? 'green' : 'red'}
                  title={test.valid ? 'Test passed: everything renders and validates' : 'Test found problems'}
                  withCloseButton
                  closeButtonLabel="Clear the test"
                  onClose={() => setTest(null)}
                >
                  <Text fz="sm">Green steps would run, grey ones are skipped, red ones have problems. Click a step for what it would send.</Text>
                  {test.inputErrors.map((e) => (
                    <Text key={e} fz="sm">
                      Input {e}
                    </Text>
                  ))}
                  {test.missingSecrets.map((s) => (
                    <Text key={s} fz="sm">
                      Missing reference <Code>{s}</Code>
                    </Text>
                  ))}
                </Alert>
              )}
            </>
          )
        }
        hint={
          readOnly
            ? 'Steps in the same column run in parallel. Click a node to see its settings.'
            : "Steps in the same column run in parallel. Drag from a node's right edge to another node to make it wait; select a link and press Delete to remove it."
        }
      >
        <WorkflowFlow
          bare
          height="100%"
          trigger={trigger}
          steps={flowSteps}
          selected={editing?.kind === 'step' ? editing.id : editing?.kind === 'trigger' ? TRIGGER_ID : null}
          onSelect={(nodeId) => setEditing(nodeId === TRIGGER_ID ? { kind: 'trigger' } : { kind: 'step', id: nodeId })}
          editable={!readOnly}
          onAdd={add}
          onConnect={connect}
          onDisconnect={disconnect}
        />
      </FlowShell>

      <Modal
        opened={editing?.kind === 'trigger' && !!doc.trigger}
        onClose={() => setEditing(null)}
        size="xl"
        title={
          <Group gap="xs">
            <Badge color="brand">Trigger</Badge>
            <Text fw={600}>{doc.trigger ? TRIGGER_TYPES[doc.trigger.type].label : ''}</Text>
          </Group>
        }
      >
        {doc.trigger && (
          <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <TriggerEditor
              trigger={doc.trigger}
              onChange={(t) => change({ trigger: t })}
              fields={fields}
              onFieldsChange={setFieldDrafts}
              onRemove={removeTrigger}
              blackouts={doc.blackouts as BlackoutWindow[] | undefined}
              blackoutMode={doc.blackoutMode as 'skip' | 'defer' | undefined}
              blackoutStatus={doc.blackout as Action['blackout']}
              onBlackoutsChange={change}
            />
          </fieldset>
        )}
      </Modal>

      <Modal
        opened={!!step}
        onClose={() => setEditing(null)}
        size="xl"
        title={
          step && (
            <Group gap="xs">
              <Badge color={STEP_TYPES[step.type].color}>{STEP_TYPES[step.type].label}</Badge>
              <Text fw={600}>{step.name || step.id}</Text>
              {!readOnly && (
                <Tooltip label="Remove step">
                  <ActionIcon variant="subtle" color="red" onClick={removeStep} aria-label="Remove step">
                    <IconTrash size={16} />
                  </ActionIcon>
                </Tooltip>
              )}
            </Group>
          )
        }
      >
        {step && (
          <Stack>
            {testOf.get(step.id) && <TestResult step={testOf.get(step.id)!} />}
            <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              <StepSettings
                steps={doc.steps}
                index={stepIndex}
                invokers={invokers}
                inputFields={form ? fields : []}
                blueprint={triggerBlueprint}
                onEntity={onEntity}
                warnings={warnings}
                update={(patch) => {
                  setSteps((steps) => patchStep(steps, stepIndex, patch));
                  if (patch.id && patch.id !== step.id) setEditing({ kind: 'step', id: patch.id });
                }}
              />
            </fieldset>
          </Stack>
        )}
      </Modal>

      <Modal opened={editing?.kind === 'general'} onClose={() => setEditing(null)} size="lg" title={<Text fw={600}>General</Text>}>
        <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <Stack gap="md">
            <GeneralFields doc={doc} isNew={false} onChange={change} />
            <TagsInput
              label="Allowed secrets"
              description="Secrets (NAME) and environment variables (env:NAME) this workflow may reference. Empty: any."
              placeholder="DEPLOY_TOKEN"
              value={(doc.secrets as string[] | undefined) ?? []}
              onChange={(secrets) => change({ secrets: secrets.length ? secrets : undefined })}
            />
            <NumberInput
              label="Run SLA (minutes)"
              description="Not finished this long after the request: the requester and admins are notified (run.sla_breached)"
              placeholder="none"
              min={1}
              value={(doc.slaMinutes as number | undefined) ?? ''}
              onChange={(n) => change({ slaMinutes: n === '' ? undefined : Number(n) })}
            />
            <RunOptionsFields doc={doc as Parameters<typeof RunOptionsFields>[0]['doc']} onChange={change} />
            <Switch
              label="Enabled"
              description="Disabled workflows are hidden from users"
              checked={doc.enabled}
              onChange={(e) => change({ enabled: e.currentTarget.checked })}
            />
          </Stack>
        </fieldset>
      </Modal>

      <Modal opened={editing?.kind === 'code'} onClose={() => setEditing(null)} size="xl" title={<Text fw={600}>Document</Text>}>
        <Text fz="sm" c="dimmed" mb="xs">
          The workflow as the API and the configuration files accept it. Edits apply to the graph at once.
        </Text>
        <Tabs
          value={codeTab}
          onChange={(t) => {
            code.open(t);
            setCodeTab(t);
          }}
        >
          <Tabs.List mb="sm">
            <CodeTabs />
          </Tabs.List>
          <CodePanels view={code} readOnly={readOnly} />
        </Tabs>
      </Modal>

      <Modal opened={editing?.kind === 'tests'} onClose={() => setEditing(null)} size="xl" title={<Text fw={600}>Tests</Text>}>
        <WorkflowTests
          identifier={doc.identifier}
          tests={(doc.tests as WorkflowTest[] | undefined) ?? []}
          onChange={(tests) => change({ tests })}
          body={body}
          readOnly={readOnly}
        />
      </Modal>

      {version !== undefined && (
        <Modal opened={editing?.kind === 'history'} onClose={() => setEditing(null)} size="xl" title={<Text fw={600}>Version history</Text>}>
          <ActionHistory
            identifier={doc.identifier}
            current={version}
            onRestored={() => {
              setEditing(null);
              void qc.invalidateQueries({ queryKey: ['action', doc.identifier] });
              void qc.invalidateQueries({ queryKey: ['admin-actions'] });
            }}
          />
        </Modal>
      )}

      {testing && <DryRunModal identifier={doc.identifier} body={body} onClose={() => setTesting(false)} onResult={setTest} />}
    </>
  );
}

function TestResult({ step }: { step: DryRunStep }) {
  const color = step.status === 'error' ? 'red' : step.status === 'skipped' ? 'gray' : 'green';
  return (
    <Alert
      color={color}
      variant="light"
      icon={step.status === 'error' ? <IconX size={18} /> : <IconFlask size={18} />}
      title={step.status === 'planned' ? 'Test: would run' : step.status === 'skipped' ? 'Test: skipped (condition is false)' : 'Test: problems'}
    >
      <Stack gap={6}>
        {step.errors.map((e) => (
          <Text key={e} fz="sm" c="red">
            {e}
          </Text>
        ))}
        {step.rendered != null && <JsonBlock value={step.rendered} maxHeight={220} />}
      </Stack>
    </Alert>
  );
}
