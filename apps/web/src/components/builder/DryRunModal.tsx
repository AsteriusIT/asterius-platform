import { useState } from 'react';
import { Alert, Badge, Button, Code, Group, Modal, ScrollArea, Stack, Text, Textarea, TextInput } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { IconFlask } from '@tabler/icons-react';
import type { DryRunResult } from '@asterius/shared';
import { api, errorText } from '../../lib/api';
import { MONO_INPUT } from './blocks';

/**
 * "Test" button of the workflow editor: renders every template, evaluates every condition and expression and
 * validates the invokers and secret references of the workflow being edited (unsaved changes included), without
 * calling any external system or creating a run.
 */

const COLORS = { planned: 'blue', skipped: 'gray', error: 'red' } as const;

export function DryRunModal({ identifier, body, onClose }: { identifier: string; body: () => Record<string, unknown>; onClose: () => void }) {
  const [inputs, setInputs] = useState('{}');
  const [entity, setEntity] = useState('');
  const [mock, setMock] = useState('{}');
  const [parseError, setParseError] = useState<string | null>(null);
  const test = useMutation({
    mutationFn: () => {
      let parsedInputs: Record<string, unknown>;
      let parsedMock: Record<string, unknown>;
      try {
        parsedInputs = JSON.parse(inputs || '{}') as Record<string, unknown>;
        parsedMock = JSON.parse(mock || '{}') as Record<string, unknown>;
      } catch (e) {
        setParseError((e as Error).message);
        return Promise.reject(new Error(`Invalid JSON: ${(e as Error).message}`));
      }
      setParseError(null);
      return api.dryRun(identifier, { definition: body(), inputs: parsedInputs, entity: entity || null, mock: parsedMock });
    },
  });
  const r: DryRunResult | undefined = test.data;
  return (
    <Modal opened onClose={onClose} title="Test the workflow" size="xl">
      <Stack>
        <Text fz="sm" c="dimmed">
          Nothing is called and no run is created. Secrets are checked, never shown.
        </Text>
        <Textarea label="Sample inputs (JSON)" autosize minRows={3} value={inputs} onChange={(e) => setInputs(e.currentTarget.value)} styles={MONO_INPUT} />
        <TextInput label="Entity identifier (workflows on an entity)" value={entity} onChange={(e) => setEntity(e.currentTarget.value)} />
        <Textarea
          label="Mocked step outputs (JSON, optional)"
          description='e.g. {"call": {"id": "abc"}}: used by later steps instead of a generic sample'
          autosize
          minRows={2}
          value={mock}
          onChange={(e) => setMock(e.currentTarget.value)}
          styles={MONO_INPUT}
        />
        <Group>
          <Button leftSection={<IconFlask size={16} />} loading={test.isPending} onClick={() => test.mutate()}>
            Run the test
          </Button>
        </Group>
        {(test.error || parseError) && (
          <Alert color="red" variant="light">
            {parseError ? `Invalid JSON: ${parseError}` : errorText(test.error)}
          </Alert>
        )}
        {r && (
          <Stack gap="xs">
            <Alert color={r.valid ? 'green' : 'red'} variant="light">
              {r.valid ? 'Everything renders and validates.' : 'Problems found.'}
              {r.inputErrors.map((e) => (
                <Text key={e} fz="sm">
                  Input {e}
                </Text>
              ))}
              {r.missingSecrets.map((s) => (
                <Text key={s} fz="sm">
                  Missing reference <Code>{s}</Code>
                </Text>
              ))}
            </Alert>
            {r.steps.map((s) => (
              <Stack key={s.id} gap={4}>
                <Group gap="xs">
                  <Badge color={COLORS[s.status]}>{s.status}</Badge>
                  <Text fw={500} fz="sm">
                    {s.id}
                  </Text>
                  <Text fz="xs" c="dimmed">
                    {s.type}
                  </Text>
                </Group>
                {s.errors.map((e) => (
                  <Text key={e} fz="sm" c="red">
                    {e}
                  </Text>
                ))}
                {s.rendered != null && (
                  <ScrollArea.Autosize mah={180}>
                    <Code block>{JSON.stringify(s.rendered, null, 2)}</Code>
                  </ScrollArea.Autosize>
                )}
              </Stack>
            ))}
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}
