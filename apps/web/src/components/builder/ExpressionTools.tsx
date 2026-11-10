import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Code, Group, Stack, Text } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { IconPlayerPlay } from '@tabler/icons-react';
import type { WorkflowStep } from '@asterius/shared';
import { api, errorText, type SimulationResult } from '../../lib/api';
import { useAppMutation } from '../../lib/queryClient';
import { CodeEditor, JsonBlock } from '../CodeEditor';

const short = (v: unknown) => {
  const t = typeof v === 'string' ? v : JSON.stringify(v);
  return t === undefined ? 'undefined' : t.length > 120 ? `${t.slice(0, 120)}…` : t;
};

/**
 * Live check of a JSONata expression via the server (syntax and a preview against `context`).
 * Renders nothing for an empty expression.
 */
export function ExpressionStatus({ expression, context }: { expression: string; context?: unknown }) {
  const [debounced] = useDebouncedValue(expression.trim(), 600);
  const q = useQuery({
    queryKey: ['expression', debounced, context],
    queryFn: () => api.checkExpression(debounced, context),
    enabled: !!debounced,
    staleTime: 30_000,
    retry: false,
  });
  if (!debounced) return null;
  if (q.error)
    return (
      <Text fz="xs" c="red" role="alert">
        {errorText(q.error)}
      </Text>
    );
  if (!q.data) return null;
  return q.data.ok ? (
    <Text fz="xs" c="dimmed">
      Valid · sample result: <Code>{short(q.data.value)}</Code>
    </Text>
  ) : (
    <Text fz="xs" c="red" role="alert">
      {q.data.error}
    </Text>
  );
}

/** Simulate the workflow on sample inputs (JSON) without executing any step. */
export function DryRunPanel({ steps }: { steps: WorkflowStep[] }) {
  const [text, setText] = useState('{}');
  const [result, setResult] = useState<SimulationResult | null>(null);
  let inputs: Record<string, unknown> | null = null;
  try {
    const v: unknown = JSON.parse(text);
    inputs = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    inputs = null;
  }
  const run = useAppMutation({ mutationFn: () => api.simulate(steps, inputs ?? {}), onSuccess: setResult });
  useEffect(() => setResult(null), [steps]);
  return (
    <Stack gap="xs">
      <CodeEditor
        language="json"
        label="Sample inputs (JSON)"
        description="Nothing is executed: conditions, transforms and templates are evaluated against these values."
        value={text}
        onChange={setText}
        error={inputs ? undefined : 'Must be a JSON object'}
        minRows={2}
        maxRows={14}
      />
      <Group>
        <Button size="xs" leftSection={<IconPlayerPlay size={14} />} loading={run.isPending} disabled={!inputs || !steps.length} onClick={() => run.mutate()}>
          Test run
        </Button>
      </Group>
      {result && (
        <Stack gap="2xs" aria-label="Test run result">
          {result.steps.map((s) => (
            <Alert key={s.id} p="xs" variant="light" color={s.error ? 'red' : s.skipped ? 'gray' : 'green'}>
              <Group gap="xs" mb="4xs">
                <Text fz="sm" fw={500}>
                  {s.id}
                </Text>
                <Badge size="xs" color="gray">
                  {s.type}
                </Badge>
                {s.skipped && <Badge size="xs">skipped</Badge>}
              </Group>
              {s.error ? (
                <Text fz="xs" c="red">
                  {s.error}
                </Text>
              ) : (
                s.preview !== undefined && <JsonBlock value={s.preview} />
              )}
            </Alert>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
