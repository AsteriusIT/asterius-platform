import { Box, Group, Text } from '@mantine/core';
import { pct } from '../lib/initiatives';

export interface TrendPoint {
  day: string;
  ratio: number;
  passing: number;
  total: number;
}

const W = 600;
const H = 160;
const PAD = { l: 36, r: 8, t: 8, b: 20 };

/**
 * Progress over time (0–100 %) as a line, with the expected straight line from the start to the deadline dashed.
 * Each point carries a tooltip (day, passing / total); the per-team table next to it is the table view.
 */
export function ProgressTrend({ points, start, end, expected }: { points: TrendPoint[]; start: string; end: string; expected?: (day: string) => number }) {
  const t0 = Date.parse(`${start}T00:00:00Z`);
  const t1 = Math.max(Date.parse(`${end}T00:00:00Z`), Date.parse(`${points.at(-1)?.day ?? end}T00:00:00Z`), t0 + 86_400_000);
  const x = (day: string) => PAD.l + ((Date.parse(`${day}T00:00:00Z`) - t0) / (t1 - t0)) * (W - PAD.l - PAD.r);
  const y = (r: number) => PAD.t + (1 - r) * (H - PAD.t - PAD.b);
  const line = points.map((p) => `${x(p.day).toFixed(1)},${y(p.ratio).toFixed(1)}`).join(' ');
  return (
    <Box>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Progress over time">
        {[0, 0.5, 1].map((r) => (
          <g key={r}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(r)} y2={y(r)} stroke="var(--mantine-color-default-border)" strokeWidth={1} />
            <text x={PAD.l - 6} y={y(r) + 4} textAnchor="end" fontSize={11} fill="var(--mantine-color-dimmed)">
              {pct(r)}
            </text>
          </g>
        ))}
        <text x={PAD.l} y={H - 4} fontSize={11} fill="var(--mantine-color-dimmed)">
          {start}
        </text>
        <text x={W - PAD.r} y={H - 4} fontSize={11} textAnchor="end" fill="var(--mantine-color-dimmed)">
          {end}
        </text>
        {expected && (
          <line x1={x(start)} y1={y(expected(start))} x2={x(end)} y2={y(1)} stroke="var(--mantine-color-gray-6)" strokeWidth={1.5} strokeDasharray="4 4" />
        )}
        {points.length > 1 && <polyline points={line} fill="none" stroke="var(--mantine-color-blue-6)" strokeWidth={2} strokeLinejoin="round" />}
        {points.map((p) => (
          <g key={p.day}>
            <circle
              cx={x(p.day)}
              cy={y(p.ratio)}
              r={points.length > 40 ? 2 : 4}
              fill="var(--mantine-color-blue-6)"
              stroke="var(--mantine-color-body)"
              strokeWidth={2}
            />
            {/* Larger invisible hit target carrying the tooltip. */}
            <circle cx={x(p.day)} cy={y(p.ratio)} r={10} fill="transparent">
              <title>{`${p.day}: ${p.passing} of ${p.total} (${pct(p.ratio)})`}</title>
            </circle>
          </g>
        ))}
      </svg>
      {expected && (
        <Group gap="md">
          <Text fz="xs" c="dimmed">
            ━ Progress
          </Text>
          <Text fz="xs" c="dimmed">
            ┄ Expected (straight line to the deadline)
          </Text>
        </Group>
      )}
    </Box>
  );
}
