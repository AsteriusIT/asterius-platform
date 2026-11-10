import { useState } from 'react';
import { ActionIcon, Alert, Button, Group, Modal, Select, Stack, Table, Text, TextInput } from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import type { EntityMigration } from '@asterius/shared';
import { api, errorText, type ImpactReport } from '../../lib/api';

const TYPES = [
  { value: 'rename', label: 'Rename a property' },
  { value: 'default', label: 'Set a default value' },
  { value: 'remove', label: 'Remove a property' },
];

/** Parse "42", "true", '{"a":1}' as JSON, otherwise keep the text. */
const parseValue = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/**
 * Shown before saving a blueprint that existing entities would no longer satisfy: how many are invalid, a
 * sample, and simple migrations (rename, default, remove) previewed against the proposed definition.
 */
export function ImpactDialog(props: {
  blueprint: string;
  /** The proposed definition (what will be saved). */
  body: Record<string, unknown>;
  report: ImpactReport | null;
  onCancel: () => void;
  onSaveAnyway: () => void;
  /** Migrate the entities, then save. */
  onMigrate: (migrations: EntityMigration[]) => void;
}) {
  const [report, setReport] = useState(props.report);
  const [rows, setRows] = useState<{ type: EntityMigration['type']; a: string; b: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const migrations = (): EntityMigration[] =>
    rows
      .filter((r) => r.a)
      .map((r) =>
        r.type === 'rename'
          ? { type: 'rename', from: r.a, to: r.b }
          : r.type === 'default'
            ? { type: 'default', property: r.a, value: parseValue(r.b) }
            : { type: 'remove', property: r.a },
      );
  const update = (i: number, patch: Partial<(typeof rows)[number]>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const recheck = async () => {
    setChecking(true);
    setError(null);
    try {
      setReport(await api.blueprintImpact(props.blueprint, props.body, migrations()));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setChecking(false);
    }
  };

  return (
    <Modal opened={!!props.report} onClose={props.onCancel} title={<Text fw={600}>Existing entities would become invalid</Text>} size="lg">
      {report && (
        <Stack>
          <Alert color={report.invalid ? 'orange' : 'green'} variant="light">
            {report.invalid
              ? `${report.invalid} of ${report.total}${report.truncated ? '+' : ''} entities do not satisfy the new definition. They stay in the catalog but fail validation at their next write.`
              : `With these migrations, all ${report.total} entities satisfy the new definition.`}
          </Alert>
          {report.samples.length > 0 && (
            <Table fz="xs" withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Entity</Table.Th>
                  <Table.Th>Problems</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {report.samples.slice(0, 8).map((s) => (
                  <Table.Tr key={s.identifier}>
                    <Table.Td>{s.title}</Table.Td>
                    <Table.Td>{s.errors.join('; ')}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
          <Text fw={500} fz="sm">
            Migrate existing entities
          </Text>
          {rows.map((r, i) => (
            <Group key={i} gap="xs" wrap="nowrap" align="flex-end">
              <Select
                data={TYPES}
                value={r.type}
                allowDeselect={false}
                onChange={(v) => update(i, { type: (v ?? 'rename') as EntityMigration['type'] })}
                w={190}
                aria-label="Migration"
              />
              <TextInput
                placeholder={r.type === 'rename' ? 'From' : 'Property'}
                value={r.a}
                onChange={(e) => update(i, { a: e.currentTarget.value })}
                flex={1}
                aria-label="Property"
              />
              {r.type !== 'remove' && (
                <TextInput
                  placeholder={r.type === 'rename' ? 'To' : 'Value'}
                  value={r.b}
                  onChange={(e) => update(i, { b: e.currentTarget.value })}
                  flex={1}
                  aria-label="Target"
                />
              )}
              <ActionIcon variant="subtle" color="red" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove migration">
                <IconTrash size={16} />
              </ActionIcon>
            </Group>
          ))}
          <Group>
            <Button
              variant="light"
              color="gray"
              c="var(--mantine-color-text)"
              leftSection={<IconPlus size={16} />}
              onClick={() => setRows([...rows, { type: 'rename', a: '', b: '' }])}
            >
              Add a migration
            </Button>
            {rows.length > 0 && (
              <Button variant="default" onClick={recheck} loading={checking}>
                Preview
              </Button>
            )}
          </Group>
          {error && (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={props.onCancel}>
              Back to the editor
            </Button>
            <Button variant="default" onClick={props.onSaveAnyway}>
              Save without migrating
            </Button>
            <Button disabled={!migrations().length} onClick={() => props.onMigrate(migrations())}>
              Migrate and save
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
