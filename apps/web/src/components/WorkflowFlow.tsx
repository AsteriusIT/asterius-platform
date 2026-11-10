import { memo, useEffect, useMemo, useRef } from 'react';
import { ActionIcon, Badge, Box, Group, Loader, Menu, Text, ThemeIcon, Tooltip, useComputedColorScheme } from '@mantine/core';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  useReactFlow,
  useStore,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconArrowsSplit,
  IconBolt,
  IconCheck,
  IconClock,
  IconCode,
  IconForms,
  IconHourglass,
  IconMinus,
  IconPlayerPlay,
  IconPlus,
  IconPuzzle,
  IconRobot,
  IconShieldCheck,
  IconSubtask,
  IconX,
} from '@tabler/icons-react';
import type { WorkflowStepType } from '@asterius/shared';
import { STEP_TYPES, stagesOf, type FlowTone } from '../lib/workflow';
import { Caption, Kicker } from './ui';

/**
 * The workflow as a graph (React Flow): the trigger, then the steps left to right, one column per stage. Used by the
 * flow editor (nodes open their settings, handles link dependencies, "+" adds a step) and by run pages (status).
 * Node borders and the edges leaving a node take the colour of its status: green done, red failed, orange waiting
 * (approval, input, wait), blue running.
 */

export interface FlowStep {
  id: string;
  name?: string;
  type: WorkflowStepType;
  needs: string[];
  tone?: FlowTone;
  /** Shown under the name instead of the step type (a status label, an error count…). */
  detail?: string | null;
  badges?: string[];
  /** A step drawn inside another one (the steps of an expanded fragment): clicking it selects `group`, and it cannot be linked or extended. */
  group?: string;
  /** Shown before the type in the node's kicker (the fragment of a grouped step). */
  groupLabel?: string;
  /** Fragment steps: whether its own steps are drawn (undefined: no toggle). */
  expanded?: boolean;
}

export interface FlowTrigger {
  title: string;
  subtitle?: string | null;
  tone?: FlowTone;
  badges?: string[];
}

export const TRIGGER_ID = '__trigger';

export const TONE_COLOR: Record<FlowTone, string> = {
  idle: 'var(--mantine-color-default-border)',
  running: 'var(--mantine-color-blue-6)',
  pending: 'var(--mantine-color-orange-6)',
  success: 'var(--mantine-color-green-6)',
  failure: 'var(--mantine-color-red-6)',
  skipped: 'var(--mantine-color-gray-5)',
};

const TONE_LABEL: Record<FlowTone, string> = {
  idle: 'Not started',
  running: 'Running',
  pending: 'Waiting',
  success: 'Done',
  failure: 'Failed',
  skipped: 'Skipped',
};

const TYPE_ICON = {
  invoke: IconBolt,
  approval: IconShieldCheck,
  agent: IconRobot,
  transform: IconCode,
  wait: IconHourglass,
  input: IconForms,
  workflow: IconSubtask,
  switch: IconArrowsSplit,
  fragment: IconPuzzle,
} as const;

/** Grid of the canvas; node positions are multiples of it so the halo under a node lines up with the background. */
const GRID = 24;
const COL = GRID * 12;
const ROW = GRID * 5;
const NODE_W = GRID * 10;

type NodeData = {
  kind: 'trigger' | 'step';
  title: string;
  kicker: string;
  detail?: string | null;
  type?: WorkflowStepType;
  tone: FlowTone;
  badges: string[];
  selected: boolean;
  editable: boolean;
  onAdd?: (type: WorkflowStepType) => void;
  /** Id selected on click (a grouped step selects its group). */
  selects: string;
  inner: boolean;
  expanded?: boolean;
  onToggle?: () => void;
};

function ToneIcon({ tone }: { tone: FlowTone }) {
  if (tone === 'idle') return null;
  if (tone === 'running') return <Loader size={14} color="blue" />;
  const Icon = tone === 'success' ? IconCheck : tone === 'failure' ? IconX : tone === 'skipped' ? IconMinus : IconClock;
  const color = tone === 'success' ? 'green' : tone === 'failure' ? 'red' : tone === 'pending' ? 'orange' : 'gray';
  return (
    <Tooltip label={TONE_LABEL[tone]}>
      <ThemeIcon size={20} radius="xl" color={color} variant={tone === 'success' || tone === 'failure' ? 'filled' : 'light'}>
        <Icon size={13} />
      </ThemeIcon>
    </Tooltip>
  );
}

const FlowNode = memo(function FlowNode({ data }: NodeProps<Node<NodeData>>) {
  const Icon = data.kind === 'trigger' ? IconPlayerPlay : TYPE_ICON[data.type!];
  const color = data.kind === 'trigger' ? 'brand' : STEP_TYPES[data.type!].color;
  const border = data.tone === 'idle' && data.selected ? 'var(--mantine-color-brand-6)' : TONE_COLOR[data.tone];
  return (
    <Box pos="relative" w={NODE_W} data-tone={data.tone} aria-label={`${data.kicker}: ${data.title}`}>
      <div className="flow-node-halo" aria-hidden />
      {data.kind === 'step' && <Handle type="target" position={Position.Left} isConnectable={data.editable} />}
      <Box
        className="flow-node"
        data-selected={data.selected || undefined}
        style={{
          borderColor: border,
          borderWidth: data.tone === 'idle' ? 1 : 2,
          borderStyle: data.tone === 'skipped' ? 'dashed' : 'solid',
          opacity: data.tone === 'skipped' ? 0.65 : 1,
          background: data.inner ? 'var(--mantine-color-default-hover)' : undefined,
        }}
      >
        <Group className="flow-node-head" gap="xs" wrap="nowrap" justify="space-between">
          <Group gap="xs" wrap="nowrap" miw={0}>
            <ThemeIcon size={28} variant="light" color={color}>
              <Icon size={16} />
            </ThemeIcon>
            <Box miw={0}>
              <Kicker size="3xs" lh={1.2} truncate>
                {data.kicker}
              </Kicker>
              <Text fz="sm" fw={600} truncate>
                {data.title}
              </Text>
              {data.detail && <Caption truncate>{data.detail}</Caption>}
            </Box>
          </Group>
          <Group gap="3xs" wrap="nowrap">
            <ToneIcon tone={data.tone} />
            {data.onToggle && (
              <Tooltip label={data.expanded ? 'Hide its steps' : 'Show its steps'}>
                <ActionIcon
                  className="nodrag"
                  size="sm"
                  variant="subtle"
                  color="gray"
                  aria-label={`${data.expanded ? 'Hide' : 'Show'} the steps of ${data.title}`}
                  aria-expanded={data.expanded}
                  onClick={(e) => {
                    e.stopPropagation();
                    data.onToggle!();
                  }}
                >
                  {data.expanded ? <IconArrowsMinimize size={14} /> : <IconArrowsMaximize size={14} />}
                </ActionIcon>
              </Tooltip>
            )}
          </Group>
        </Group>
        {data.badges.length > 0 && (
          <Group gap="3xs" mt="2xs">
            {data.badges.map((b) => (
              <Badge key={b} size="xs" variant="light" color="gray">
                {b}
              </Badge>
            ))}
          </Group>
        )}
      </Box>
      <Handle type="source" position={Position.Right} isConnectable={data.editable} />
      {data.editable && data.onAdd && (
        <Menu position="right-start" width={300} withinPortal>
          <Menu.Target>
            <ActionIcon
              className="nodrag flow-node-add"
              size="sm"
              radius="xl"
              variant="default"
              aria-label={`Add a step after ${data.title}`}
              onClick={(e) => e.stopPropagation()}
            >
              <IconPlus size={14} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown onClick={(e) => e.stopPropagation()}>
            <StepTypeItems onPick={data.onAdd} />
          </Menu.Dropdown>
        </Menu>
      )}
    </Box>
  );
});

/** The step types, as menu items (the "+" of a node and the editor toolbar). */
export function StepTypeItems({ onPick }: { onPick: (type: WorkflowStepType) => void }) {
  return (
    <>
      {(Object.keys(STEP_TYPES) as WorkflowStepType[]).map((t) => {
        const Icon = TYPE_ICON[t];
        return (
          <Menu.Item key={t} leftSection={<Icon size={16} />} onClick={() => onPick(t)}>
            <Text fz="sm" fw={500}>
              {STEP_TYPES[t].label}
            </Text>
            <Text fz="xs" c="dimmed">
              {STEP_TYPES[t].hint}
            </Text>
          </Menu.Item>
        );
      })}
    </>
  );
}

const NODE_TYPES = { flow: FlowNode };
const FIT = { padding: 0.15, minZoom: 0.7, maxZoom: 1 };

/**
 * Fits the graph again when the canvas is resized or a node is added or removed (fitView only runs at start). When
 * the whole graph does not fit at the smallest zoom of a fit (a side panel took half of the canvas), the node in
 * `focus` is centred instead, so the step being read is never off screen.
 */
function AutoFit({ nodes, focus }: { nodes: number; focus?: string | null }) {
  const { fitView, getNodes, getNodesBounds } = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const fitted = useRef('');
  useEffect(() => {
    if (!width || !height) return;
    // After the new nodes are measured.
    const t = setTimeout(() => {
      const all = getNodes();
      const bounds = getNodesBounds(all);
      const room = 1 + FIT.padding;
      const fits = width / (bounds.width * room) >= FIT.minZoom && height / (bounds.height * room) >= FIT.minZoom;
      const layout = `${width}x${height}/${nodes}`;
      if (!fits && focus && all.some((n) => n.id === focus)) {
        void fitView({ nodes: [{ id: focus }], minZoom: FIT.minZoom, maxZoom: FIT.minZoom, duration: 150 });
      } else if (fitted.current !== layout) {
        // Only when the canvas or the graph changed: selecting a node does not undo a manual pan or zoom.
        void fitView({ ...FIT, duration: 150 });
      }
      fitted.current = layout;
    }, 50);
    return () => clearTimeout(t);
  }, [fitView, getNodes, getNodesBounds, width, height, nodes, focus]);
  return null;
}

export function WorkflowFlow(props: {
  trigger?: FlowTrigger | null;
  steps: FlowStep[];
  selected?: string | null;
  /** A node was clicked: a step id, or TRIGGER_ID. */
  onSelect?: (id: string) => void;
  /** Editor only. */
  editable?: boolean;
  /** "+" of a node: add a step after it (TRIGGER_ID: at the start). */
  onAdd?: (after: string, type: WorkflowStepType) => void;
  onConnect?: (source: string, target: string) => void;
  onDisconnect?: (source: string, target: string) => void;
  /** Toggle of a fragment step (FlowStep.expanded). */
  onToggle?: (id: string) => void;
  height?: number | string;
  /** No frame (the flow views, where the canvas is the page). */
  bare?: boolean;
  /** Node kept in view when the graph is wider than the canvas (the step open in a side panel). */
  focus?: string | null;
}) {
  const { trigger, steps, selected, editable = false, onAdd, onToggle } = props;
  const colorMode = useComputedColorScheme('light');

  const { nodes, edges } = useMemo(() => {
    const stages = stagesOf(steps);
    const tones = new Map(steps.map((s) => [s.id, s.tone ?? 'idle']));
    const offset = trigger ? 1 : 0;
    const nodes: Node<NodeData>[] = [];
    const rowsOf = (n: number, i: number) => Math.round(((i - (n - 1) / 2) * ROW) / GRID) * GRID;
    if (trigger) {
      nodes.push({
        id: TRIGGER_ID,
        type: 'flow',
        position: { x: 0, y: 0 },
        connectable: false,
        deletable: false,
        data: {
          kind: 'trigger',
          kicker: 'Trigger',
          title: trigger.title,
          detail: trigger.subtitle,
          tone: trigger.tone ?? 'idle',
          badges: trigger.badges ?? [],
          selected: selected === TRIGGER_ID,
          editable,
          onAdd: onAdd ? (t) => onAdd(TRIGGER_ID, t) : undefined,
          selects: TRIGGER_ID,
          inner: false,
        },
      });
    }
    stages.forEach((stage, c) =>
      stage.forEach((s, r) =>
        nodes.push({
          id: s.id,
          type: 'flow',
          position: { x: (c + offset) * COL, y: rowsOf(stage.length, r) },
          deletable: false,
          connectable: !s.group,
          data: {
            kind: 'step',
            kicker: s.groupLabel ? `${s.groupLabel} · ${STEP_TYPES[s.type].label}` : STEP_TYPES[s.type].label,
            title: s.name || s.id,
            detail: s.detail,
            type: s.type,
            tone: s.tone ?? 'idle',
            badges: s.badges ?? [],
            selected: selected === s.id || (!!s.group && selected === s.group),
            editable: editable && !s.group,
            onAdd: onAdd && !s.group ? (t) => onAdd(s.id, t) : undefined,
            selects: s.group ?? s.id,
            inner: !!s.group,
            expanded: s.expanded,
            onToggle: onToggle && s.expanded !== undefined ? () => onToggle(s.id) : undefined,
          },
        }),
      ),
    );
    const grouped = new Set(steps.filter((s) => s.group).map((s) => s.id));
    const edge = (source: string, target: string, tone: FlowTone): Edge => {
      const stroke = tone === 'idle' ? 'var(--mantine-color-gray-5)' : TONE_COLOR[tone];
      return {
        id: `${source}->${target}`,
        source,
        target,
        type: 'smoothstep',
        animated: tone === 'running',
        // Links of a fragment's own steps are drawn, not edited (they belong to the fragment).
        deletable: editable && source !== TRIGGER_ID && !grouped.has(source) && !grouped.has(target),
        style: { stroke, strokeWidth: tone === 'idle' ? 1.5 : 2.5, strokeDasharray: tone === 'skipped' ? '5 4' : undefined },
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 16, height: 16 },
      };
    };
    const edges: Edge[] = [];
    for (const s of steps) {
      if (!s.needs.length && trigger) edges.push(edge(TRIGGER_ID, s.id, trigger.tone ?? 'idle'));
      for (const d of s.needs) if (tones.has(d)) edges.push(edge(d, s.id, tones.get(d)!));
    }
    return { nodes, edges };
  }, [trigger, steps, selected, editable, onAdd, onToggle]);

  return (
    <Box h={props.height ?? 360} className={props.bare ? 'workflow-flow workflow-flow-bare' : 'workflow-flow'} aria-label="Workflow graph">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        colorMode={colorMode}
        fitView
        fitViewOptions={FIT}
        minZoom={0.3}
        maxZoom={1.5}
        nodesDraggable={false}
        nodesConnectable={editable}
        elementsSelectable={editable}
        edgesFocusable={editable}
        deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
        snapToGrid
        snapGrid={[GRID, GRID]}
        onNodeClick={(_, n) => props.onSelect?.(n.data.selects)}
        onConnect={(c) => c.source && c.target && c.source !== TRIGGER_ID && props.onConnect?.(c.source, c.target)}
        onEdgesDelete={(es) => es.forEach((e) => props.onDisconnect?.(e.source, e.target))}
        zoomOnScroll={editable}
        preventScrolling={editable}
        panOnScroll={false}
      >
        <Background id="flow-grid" variant={BackgroundVariant.Lines} gap={GRID} color="var(--flow-grid-faint)" />
        <Controls showInteractive={false} position="bottom-left" />
        <AutoFit nodes={nodes.length} focus={props.focus} />
      </ReactFlow>
    </Box>
  );
}
