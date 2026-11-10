import type { ReactNode } from 'react';
import { Checkbox, Group, Pagination, Paper, Skeleton, Table, Text, UnstyledButton } from '@mantine/core';
import { IconArrowDown, IconArrowUp, IconArrowsSort } from '@tabler/icons-react';
import { Empty, ErrorAlert } from './ui';

export interface Column<T> {
  key: string;
  label: ReactNode;
  render: (row: T) => ReactNode;
  width?: number | string;
  /** Header becomes a button that sorts by this key (see `sort` prop). */
  sortable?: boolean;
}

export interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}

export interface Selection {
  selected: ReadonlySet<string>;
  onChange: (keys: Set<string>) => void;
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
  sort?: { value: SortState | null; onChange: (key: string) => void };
  /** Adds a checkbox column; keys are `rowKey` values. */
  selection?: Selection;
  page?: { page: number; pageSize: number; total: number; onChange: (p: number) => void };
}) {
  const { columns, rows, page, sort, selection } = props;
  const allSelected = !!rows?.length && rows.every((r) => selection?.selected.has(props.rowKey(r)));
  const someSelected = !!rows?.some((r) => selection?.selected.has(props.rowKey(r)));
  const toggleAll = () => {
    if (!selection || !rows) return;
    const next = new Set(selection.selected);
    for (const r of rows) {
      if (allSelected) next.delete(props.rowKey(r));
      else next.add(props.rowKey(r));
    }
    selection.onChange(next);
  };
  const toggle = (key: string) => {
    if (!selection) return;
    const next = new Set(selection.selected);
    if (!next.delete(key)) next.add(key);
    selection.onChange(next);
  };
  if (props.error) return <ErrorAlert error={props.error} />;
  return (
    <Paper radius="md" style={{ overflow: 'hidden' }}>
      <Table.ScrollContainer minWidth={640}>
        <Table>
          <Table.Thead>
            <Table.Tr>
              {selection && (
                <Table.Th w={40}>
                  <Checkbox aria-label="Select all rows" checked={allSelected} indeterminate={!allSelected && someSelected} onChange={toggleAll} />
                </Table.Th>
              )}
              {columns.map((c) => {
                const active = sort?.value?.key === c.key ? sort.value.dir : null;
                return (
                  <Table.Th key={c.key} w={c.width} aria-sort={active ? (active === 'asc' ? 'ascending' : 'descending') : undefined}>
                    {c.sortable && sort ? (
                      <UnstyledButton
                        onClick={() => sort.onChange(c.key)}
                        fz="inherit"
                        fw="inherit"
                        aria-label={`Sort by ${typeof c.label === 'string' ? c.label : c.key}`}
                        className="data-table-sort"
                      >
                        <Group gap={4} wrap="nowrap">
                          {c.label}
                          {active === 'asc' ? (
                            <IconArrowUp size={14} className="data-table-sort-icon" data-active />
                          ) : active === 'desc' ? (
                            <IconArrowDown size={14} className="data-table-sort-icon" data-active />
                          ) : (
                            <IconArrowsSort size={14} className="data-table-sort-icon" />
                          )}
                        </Group>
                      </UnstyledButton>
                    ) : (
                      c.label
                    )}
                  </Table.Th>
                );
              })}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {props.loading &&
              [0, 1, 2].map((i) => (
                <Table.Tr key={i}>
                  {selection && <Table.Td />}
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
                  data-selected={selection?.selected.has(props.rowKey(r)) || undefined}
                >
                  {selection && (
                    <Table.Td onClick={(e) => e.stopPropagation()}>
                      <Checkbox aria-label="Select row" checked={selection.selected.has(props.rowKey(r))} onChange={() => toggle(props.rowKey(r))} />
                    </Table.Td>
                  )}
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
        <Group justify="space-between" py="xs" px="md" className="data-table-footer">
          <Text fz="sm" c="dimmed">
            {(page.page - 1) * page.pageSize + 1}–{Math.min(page.page * page.pageSize, page.total)} of {page.total}
          </Text>
          <Pagination size="sm" value={page.page} onChange={page.onChange} total={Math.ceil(page.total / page.pageSize)} />
        </Group>
      )}
    </Paper>
  );
}
