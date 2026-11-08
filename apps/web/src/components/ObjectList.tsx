import { Card, Text } from '@mantine/core';
import type { PropertySchema } from '@asterius/shared';
import { DataTable } from './DataTable';
import { PropertyValue } from './PropertyValue';

/** A property holding a list of objects (managed resources, policy violations, conditions…). */
export const isObjectList = (schema: PropertySchema | undefined, value: unknown) =>
  (schema?.type === 'array' && schema.items?.type === 'object') ||
  (Array.isArray(value) && value.length > 0 && value.every((v) => !!v && typeof v === 'object' && !Array.isArray(v)));

const MAX_COLUMNS = 8;

/** The list as a table: one column per key (first-seen order), values rendered like any property. */
export function ObjectListCard({ title, value }: { title: string; value: unknown }) {
  const rows = (Array.isArray(value) ? value : []).filter((v): v is Record<string, unknown> => !!v && typeof v === 'object');
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].slice(0, MAX_COLUMNS);
  return (
    <Card>
      <Text fw={600} mb="sm">
        {title}
        {rows.length > 0 && (
          <Text span c="dimmed" fz="sm" fw={400}>
            {' '}
            · {rows.length}
          </Text>
        )}
      </Text>
      <DataTable
        rows={rows}
        rowKey={(r) => JSON.stringify(r)}
        empty="None"
        columns={keys.map((k) => ({ key: k, label: k, render: (r: Record<string, unknown>) => <PropertyValue value={r[k]} compact /> }))}
      />
    </Card>
  );
}
