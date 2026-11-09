import { useState } from 'react';
import { Alert, Badge, Button, Code, Group, Stack, Table, Text } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { IconPlayerPlay, IconTestPipe } from '@tabler/icons-react';
import type { WorkflowTest, WorkflowTestReport, WorkflowTestResult } from '@asterius/shared';
import { api, errorText } from '../../lib/api';
import { CodeEditor } from '../CodeEditor';

/**
 * "Tests" of the workflow editor: the action's `tests` as JSON, run against the workflow being edited (unsaved changes
 * included) by POST /actions/:id/tests/run. Invoke, agent and workflow steps must be mocked; approvals are approved,
 * waits resolve at once. Nothing external is called and no run is created.
 */

const EXAMPLE: WorkflowTest[] = [
  {
    name: 'happy path',
    inputs: {},
    mocks: { deploy: { status: 'SUCCESS', output: { url: 'https://example.test' } } },
    expect: { status: 'SUCCESS', steps: { deploy: { status: 'SUCCESS' } } },
  },
];

export function WorkflowTests({
  identifier,
  tests,
  onChange,
  body,
  readOnly,
}: {
  identifier: string;
  tests: WorkflowTest[];
  onChange: (tests: WorkflowTest[] | undefined) => void;
  body: () => Record<string, unknown>;
  readOnly?: boolean;
}) {
  const [text, setText] = useState(() => JSON.stringify(tests.length ? tests : [], null, 2));
  const [parseError, setParseError] = useState<string | null>(null);
  const [report, setReport] = useState<WorkflowTestReport | null>(null);
  const edit = (v: string) => {
    setText(v);
    try {
      const parsed = JSON.parse(v || '[]') as unknown;
      if (!Array.isArray(parsed)) throw new Error('A list of tests is expected: [ { "name": …, "mocks": …, "expect": … } ]');
      setParseError(null);
      onChange(parsed.length ? (parsed as WorkflowTest[]) : undefined);
    } catch (e) {
      setParseError((e as Error).message);
    }
  };
  const run = useMutation({
    mutationFn: (name?: string) => api.runWorkflowTests(identifier, { name, definition: body() }),
    onSuccess: setReport,
  });
  return (
    <Stack>
      <Text fz="sm" c="dimmed">
        Each test simulates a run with its inputs. Invoke, agent and workflow steps must be mocked (<Code>{'mocks.<step>: { status, output }'}</Code>);
        approvals are approved and waits resolve at once unless mocked. <Code>expect.status</Code> defaults to SUCCESS; step outputs and <Code>outputs</Code>{' '}
        are partial matches. Save the workflow to keep the tests.
      </Text>
      <CodeEditor
        language="json"
        value={text}
        onChange={readOnly ? undefined : edit}
        readOnly={readOnly}
        error={parseError}
        minRows={10}
        maxRows={24}
        aria-label="Tests"
      />
      <Group>
        {!readOnly && !tests.length && (
          <Button size="xs" variant="default" onClick={() => edit(JSON.stringify(EXAMPLE, null, 2))}>
            Insert an example
          </Button>
        )}
        <Button
          size="xs"
          leftSection={<IconPlayerPlay size={14} />}
          loading={run.isPending}
          disabled={!!parseError || !tests.length}
          onClick={() => run.mutate(undefined)}
        >
          Run all tests
        </Button>
      </Group>
      {run.error && <Alert color="red">{errorText(run.error)}</Alert>}
      {report && (
        <Stack gap="xs">
          <Alert color={report.failed ? 'red' : 'green'} icon={<IconTestPipe size={18} />} title={`${report.passed} passed · ${report.failed} failed`} />
          {report.results.map((r) => (
            <TestResultCard key={r.name} r={r} onRerun={() => run.mutate(r.name)} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function TestResultCard({ r, onRerun }: { r: WorkflowTestResult; onRerun: () => void }) {
  return (
    <Alert color={r.passed ? 'green' : 'red'} variant="light">
      <Group justify="space-between" mb={4}>
        <Group gap="xs">
          <Badge color={r.passed ? 'green' : 'red'}>{r.passed ? 'PASS' : 'FAIL'}</Badge>
          <Text fw={600} fz="sm">
            {r.name}
          </Text>
          <Text fz="xs" c="dimmed">
            run {r.status}
          </Text>
        </Group>
        <Button size="compact-xs" variant="subtle" onClick={onRerun}>
          Run again
        </Button>
      </Group>
      {r.errors.map((e) => (
        <Text key={e} fz="sm" c="red">
          {e}
        </Text>
      ))}
      {r.diffs.length > 0 && (
        <Table fz="xs" withRowBorders={false} verticalSpacing={2}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Path</Table.Th>
              <Table.Th>Expected</Table.Th>
              <Table.Th>Actual</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {r.diffs.map((d) => (
              <Table.Tr key={d.path}>
                <Table.Td>
                  <Code>{d.path}</Code>
                </Table.Td>
                <Table.Td style={{ overflowWrap: 'anywhere' }}>{JSON.stringify(d.expected)}</Table.Td>
                <Table.Td style={{ overflowWrap: 'anywhere' }}>{JSON.stringify(d.actual)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      <Text fz="xs" c="dimmed" mt={4}>
        {r.steps.map((s) => `${s.id}: ${s.status}${s.error ? ` (${s.error})` : ''}`).join(' · ')}
      </Text>
    </Alert>
  );
}
