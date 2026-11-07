import { useState, type ReactNode } from 'react';
import { ActionIcon, Button, Group, Menu, Stack, Text, Tooltip } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconChevronDown, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { errorText } from '../../lib/api';
import { notifyError } from '../../lib/queryClient';
import { DataTable, type Column } from '../../components/DataTable';
import { ManagedBadge, PageHeader } from '../../components/ui';
import { ResourceEditor } from '../../components/ResourceEditor';
import type { EditorProps } from '../../components/builder/FormBuilder';

interface Resource {
  identifier: string;
  title: string;
  managed: boolean;
}

/**
 * Admin page for one kind of configurable resource: list, create from templates, edit in a form dialog
 * (with JSON / YAML views), delete.
 * Managed (configuration-as-code) resources open read-only.
 */
export function ResourceAdmin<T extends Resource>(props: {
  title: string;
  description: ReactNode;
  queryKey: string;
  list: () => Promise<T[]>;
  columns: Column<T>[];
  templates: { label: string; value: Record<string, unknown> }[];
  /** Editable document of an existing resource (strip computed fields). */
  toEditable: (item: T) => Record<string, unknown> | Promise<Record<string, unknown>>;
  save: (id: string, body: Record<string, unknown>) => Promise<unknown>;
  remove: (item: T) => Promise<unknown>;
  removeWarning?: (item: T) => ReactNode;
  rowActions?: (item: T) => ReactNode;
  onRowClick?: (item: T) => void;
  help?: ReactNode;
  children?: ReactNode;
  /** Form dialog editing one resource (builders in components/builder). Without it: the YAML editor. */
  editor?: (p: EditorProps) => ReactNode;
}) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: [props.queryKey], queryFn: props.list });
  const [editing, setEditing] = useState<{ value: Record<string, unknown>; isNew: boolean; readOnly: boolean } | null>(null);

  const onSave = async (id: string, body: Record<string, unknown>) => {
    const r = await props.save(id, body);
    notifications.show({ color: 'green', message: `${id} saved` });
    void qc.invalidateQueries({ queryKey: [props.queryKey] });
    void qc.invalidateQueries({ queryKey: ['blueprints'] });
    void qc.invalidateQueries({ queryKey: ['actions'] });
    return r;
  };
  const open = async (item: T) => {
    try {
      setEditing({ value: await props.toEditable(item), isNew: false, readOnly: item.managed });
    } catch (e) {
      notifyError(e, `Cannot open ${item.title}`);
    }
  };
  const remove = (item: T) =>
    modals.openConfirmModal({
      title: `Delete ${item.title}?`,
      children: <Text fz="sm">{props.removeWarning?.(item) ?? 'This cannot be undone.'}</Text>,
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await props.remove(item);
          void qc.invalidateQueries({ queryKey: [props.queryKey] });
          notifications.show({ message: `${item.identifier} deleted` });
        } catch (e) {
          notifications.show({ color: 'red', title: 'Cannot delete', message: errorText(e) });
        }
      },
    });

  const columns: Column<T>[] = [
    {
      key: 'title',
      label: 'Name',
      render: (r) => (
        <Group gap="xs" wrap="nowrap">
          <div>
            <Text fz="sm" fw={500}>
              {r.title}
            </Text>
            <Text fz="xs" c="dimmed">
              {r.identifier}
            </Text>
          </div>
          <ManagedBadge managed={r.managed} />
        </Group>
      ),
    },
    ...props.columns,
    {
      key: 'actions',
      label: '',
      width: 120,
      render: (r) => (
        <Group gap={4} justify="flex-end" wrap="nowrap" onClick={(e) => e.stopPropagation()}>
          {props.rowActions?.(r)}
          <Tooltip label={r.managed ? 'View' : 'Edit'}>
            <ActionIcon variant="subtle" onClick={() => void open(r)} aria-label="Edit">
              <IconPencil size={16} />
            </ActionIcon>
          </Tooltip>
          {!r.managed && (
            <Tooltip label="Delete">
              <ActionIcon variant="subtle" color="red" onClick={() => remove(r)} aria-label="Delete">
                <IconTrash size={16} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      ),
    },
  ];

  const newButton =
    props.templates.length > 1 ? (
      <Menu position="bottom-end">
        <Menu.Target>
          <Button leftSection={<IconPlus size={16} />} rightSection={<IconChevronDown size={14} />}>
            New
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          {props.templates.map((t) => (
            <Menu.Item key={t.label} onClick={() => setEditing({ value: t.value, isNew: true, readOnly: false })}>
              {t.label}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
    ) : (
      <Button
        leftSection={<IconPlus size={16} />}
        onClick={() => props.templates[0] && setEditing({ value: props.templates[0].value, isNew: true, readOnly: false })}
      >
        New
      </Button>
    );

  return (
    <Stack>
      <PageHeader title={props.title} description={props.description} actions={newButton} refresh={q} />
      {props.children}
      <DataTable
        rows={q.data}
        loading={q.isPending}
        error={q.error}
        rowKey={(r) => r.identifier}
        columns={columns}
        onRowClick={props.onRowClick ?? ((r) => void open(r))}
        empty={`No ${props.title.toLowerCase()} yet`}
      />
      {props.editor ? (
        props.editor({ value: editing?.value ?? null, isNew: !!editing?.isNew, readOnly: editing?.readOnly, onSave, onClose: () => setEditing(null) })
      ) : (
        <ResourceEditor
          title={
            editing?.isNew
              ? `New ${props.title.replace(/s$/, '').toLowerCase()}`
              : `${editing?.readOnly ? 'View' : 'Edit'} ${String(editing?.value.identifier ?? '')}`
          }
          value={editing?.value ?? null}
          isNew={!!editing?.isNew}
          readOnly={editing?.readOnly}
          help={props.help}
          onClose={() => setEditing(null)}
          onSave={onSave}
        />
      )}
    </Stack>
  );
}

export const strip = <T extends object>(o: T, keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
