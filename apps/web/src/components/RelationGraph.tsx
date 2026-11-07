import { Anchor, Box, Group, ScrollArea, Text } from '@mantine/core';
import { useNavigate } from 'react-router';
import type { EntityGraph } from '../lib/api';

const COL_W = 220;
const ROW_H = 56;
const NODE_W = 170;
const NODE_H = 34;

export interface Placed {
  id: string;
  blueprint: string;
  identifier: string;
  title: string;
  depth: number;
  x: number;
  y: number;
}

/** Columns by distance from the entity (0 = the entity itself), rows in arrival order. */
export function layoutGraph(nodes: EntityGraph['nodes']): { placed: Placed[]; width: number; height: number } {
  const rows = new Map<number, number>();
  const placed = nodes.map((n) => {
    const row = rows.get(n.depth) ?? 0;
    rows.set(n.depth, row + 1);
    return { ...n, x: 10 + n.depth * COL_W, y: 10 + row * ROW_H };
  });
  const cols = Math.max(0, ...nodes.map((n) => n.depth)) + 1;
  return { placed, width: 20 + (cols - 1) * COL_W + NODE_W, height: 20 + Math.max(1, ...rows.values()) * ROW_H };
}

/** Interactive relation graph: click a node to open that entity. Edges are labelled with the relation name. */
export function RelationGraph({ graph }: { graph: EntityGraph }) {
  const navigate = useNavigate();
  const { placed, width, height } = layoutGraph(graph.nodes);
  const byId = new Map(placed.map((p) => [p.id, p]));
  if (graph.nodes.length <= 1) return <Text c="dimmed">This entity has no relation yet.</Text>;
  return (
    <Box>
      <ScrollArea type="auto">
        <svg width={width} height={height} role="img" aria-label="Relation graph">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--mantine-color-gray-6)" />
            </marker>
          </defs>
          {graph.edges.map((e) => {
            const a = byId.get(e.from);
            const b = byId.get(e.to);
            if (!a || !b) return null;
            const leftToRight = a.x <= b.x;
            const x1 = leftToRight ? a.x + NODE_W : a.x;
            const x2 = leftToRight ? b.x : b.x + NODE_W;
            const y1 = a.y + NODE_H / 2;
            const y2 = b.y + NODE_H / 2;
            return (
              <g key={`${e.from}|${e.relation}|${e.to}`}>
                <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--mantine-color-gray-5)" strokeWidth={1.2} markerEnd="url(#arrow)" />
                <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 3} fontSize={10} textAnchor="middle" fill="var(--mantine-color-dimmed)">
                  {e.relation}
                </text>
              </g>
            );
          })}
          {placed.map((n) => (
            <g
              key={n.id}
              transform={`translate(${n.x},${n.y})`}
              role="link"
              tabIndex={0}
              aria-label={`Open ${n.title}`}
              style={{ cursor: n.depth === 0 ? 'default' : 'pointer' }}
              onClick={() => n.depth > 0 && void navigate(`/catalog/${n.blueprint}/${encodeURIComponent(n.identifier)}`)}
              onKeyDown={(e) => e.key === 'Enter' && n.depth > 0 && void navigate(`/catalog/${n.blueprint}/${encodeURIComponent(n.identifier)}`)}
            >
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={8}
                fill="var(--mantine-color-body)"
                stroke={n.depth === 0 ? 'var(--mantine-primary-color-filled)' : 'var(--mantine-color-default-border)'}
                strokeWidth={n.depth === 0 ? 2 : 1}
              />
              <text x={10} y={14} fontSize={12} fontWeight={500} fill="var(--mantine-color-text)">
                {n.title.length > 22 ? `${n.title.slice(0, 21)}…` : n.title}
              </text>
              <text x={10} y={27} fontSize={10} fill="var(--mantine-color-dimmed)">
                {n.blueprint}
              </text>
            </g>
          ))}
        </svg>
      </ScrollArea>
      {graph.truncated && (
        <Group mt="xs">
          <Text fz="xs" c="dimmed">
            Showing the first {graph.nodes.length} entities.
          </Text>
        </Group>
      )}
      <Text fz="xs" c="dimmed" mt="xs">
        Arrows follow the relation direction. <Anchor fz="xs">Click a node</Anchor> to open it.
      </Text>
    </Box>
  );
}
