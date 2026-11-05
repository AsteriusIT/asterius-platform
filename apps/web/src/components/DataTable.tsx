import type { ReactNode } from 'react';
import { Group, Pagination, Paper, Skeleton, Table, Text } from '@mantine/core';
import { Empty, ErrorAlert } from './ui';

export interface Column<T> {
  key: string;
  label: ReactNode;
  render: (row: T) => ReactNode;
  width?: number | string;
}

/**
 * The one table of the portal: columns, loading skeleton, empty state, row click and server-side paging.
 */
export function DataTable<T>(props: {
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  loading?: boolean;
  error?: unknown;
  onRowClick?: (row: T) => void;
  empty?: ReactNode;
  page?: { page: number; pageSize: number; total: number; onChange: (p: number) => void };
}) {
  const { columns, rows, page } = props;
  if (props.error) return <ErrorAlert error={props.error} />;
  return (
    <Paper radius="md" style={{ overflow: 'hidden' }}>
      <Table.ScrollContainer minWidth={640}>
        <Table>
          <Table.Thead>
            <Table.Tr>
              {columns.map((c) => (
                <Table.Th key={c.key} w={c.width}>
                  {c.label}
                </Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {props.loading &&
              [0, 1, 2].map((i) => (
                <Table.Tr key={i}>
                  {columns.map((c) => (
                    <Table.Td key={c.key}>
                      <Skeleton h={14} />
                    </Table.Td>
                  ))}
                </Table.Tr>
              ))}
            {!props.loading &&
              rows?.map((r) => (
                <Table.Tr
                  key={props.rowKey(r)}
                  onClick={props.onRowClick ? () => props.onRowClick!(r) : undefined}
                  style={props.onRowClick ? { cursor: 'pointer' } : undefined}
                >
                  {columns.map((c) => (
                    <Table.Td key={c.key}>{c.render(r)}</Table.Td>
                  ))}
                </Table.Tr>
              ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {!props.loading &&
        !rows?.length &&
        (typeof props.empty === 'string' || !props.empty ? <Empty title={(props.empty as string) ?? 'Nothing here yet'} /> : props.empty)}
      {page && page.total > page.pageSize && (
        <Group justify="space-between" p="sm" style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}>
          <Text fz="sm" c="dimmed">
            {(page.page - 1) * page.pageSize + 1}–{Math.min(page.page * page.pageSize, page.total)} of {page.total}
          </Text>
          <Pagination size="sm" value={page.page} onChange={page.onChange} total={Math.ceil(page.total / page.pageSize)} />
        </Group>
      )}
    </Paper>
  );
}
