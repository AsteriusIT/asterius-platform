import { useState } from 'react';
import { ActionIcon, Badge, Button, Checkbox, CloseButton, Group, Menu, Popover, Select, Stack, TextInput } from '@mantine/core';
import { IconColumns, IconDeviceFloppy, IconFilter, IconLink, IconTrash } from '@tabler/icons-react';
import type { Blueprint } from '@asterius/shared';
import { type SavedView } from '../lib/catalogView';

/** Active property filters as removable chips plus a small "add filter" popover. */
export function FilterBar({
  bp,
  props,
  filters,
  onChange,
}: {
  bp: Blueprint;
  props: string[];
  filters: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const [prop, setProp] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  const schema = prop ? bp.schema.properties[prop] : null;
  const label = (k: string) => bp.schema.properties[k]?.title ?? k;
  const submit = () => {
    if (!prop || value === '') return;
    onChange({ ...filters, [prop]: value });
    setProp(null);
    setValue('');
    setOpen(false);
  };
  const options = schema?.enum?.map(String) ?? (schema?.type === 'boolean' ? ['true', 'false'] : null);
  return (
    <Group gap="xs">
      <Popover opened={open} onChange={setOpen} position="bottom-start" withArrow trapFocus>
        <Popover.Target>
          <Button variant="default" leftSection={<IconFilter size={16} />} onClick={() => setOpen((o) => !o)} disabled={!props.length}>
            Add filter
          </Button>
        </Popover.Target>
        <Popover.Dropdown>
          <Stack
            gap="xs"
            w={240}
            component="form"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <Select
              label="Property"
              data={props.map((k) => ({ value: k, label: label(k) }))}
              value={prop}
              onChange={(v) => {
                setProp(v);
                setValue('');
              }}
            />
            {options ? (
              <Select label="Value" data={options} value={value || null} onChange={(v) => setValue(v ?? '')} />
            ) : (
              <TextInput label="Equals" value={value} onChange={(e) => setValue(e.currentTarget.value)} />
            )}
            <Button type="submit" size="xs" disabled={!prop || value === ''}>
              Apply
            </Button>
          </Stack>
        </Popover.Dropdown>
      </Popover>
      {Object.entries(filters).map(([k, v]) => (
        <Badge
          key={k}
          size="lg"
          variant="light"
          tt="none"
          rightSection={
            <CloseButton
              size="xs"
              aria-label={`Remove filter ${label(k)}`}
              onClick={() => {
                const next = { ...filters };
                delete next[k];
                onChange(next);
              }}
            />
          }
        >
          {label(k)}: {v}
        </Badge>
      ))}
    </Group>
  );
}

/** Choose which property columns the table shows (persisted per blueprint by the caller). */
export function ColumnPicker({
  bp,
  props,
  visible,
  onChange,
}: {
  bp: Blueprint;
  props: string[];
  visible: string[];
  onChange: (cols: string[] | null) => void;
}) {
  return (
    <Popover position="bottom-end" withArrow>
      <Popover.Target>
        <ActionIcon variant="default" size="lg" aria-label="Choose columns" title="Columns">
          <IconColumns size={18} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs" role="group" aria-label="Columns">
          {props.map((k) => (
            <Checkbox
              key={k}
              label={bp.schema.properties[k].title ?? k}
              checked={visible.includes(k)}
              onChange={(e) => onChange(props.filter((p) => (p === k ? e.currentTarget.checked : visible.includes(p))))}
            />
          ))}
          <Button size="xs" variant="subtle" onClick={() => onChange(null)}>
            Reset
          </Button>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

/** Saved views: named URL states kept in this browser; the page URL itself is the shareable link. */
export function ViewsMenu({
  views,
  onApply,
  onSave,
  onDelete,
  onCopyLink,
}: {
  views: SavedView[];
  onApply: (v: SavedView) => void;
  onSave: (name: string) => void;
  onDelete: (name: string) => void;
  onCopyLink: () => void;
}) {
  const [name, setName] = useState('');
  return (
    <Menu position="bottom-end" width={260} closeOnItemClick={false}>
      <Menu.Target>
        <Button variant="default" leftSection={<IconDeviceFloppy size={16} />}>
          Views
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        {views.length === 0 && <Menu.Label>No saved views</Menu.Label>}
        {views.map((v) => (
          <Menu.Item
            key={v.name}
            onClick={() => onApply(v)}
            rightSection={
              <ActionIcon
                size="sm"
                variant="subtle"
                color="red"
                aria-label={`Delete view ${v.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(v.name);
                }}
              >
                <IconTrash size={14} />
              </ActionIcon>
            }
          >
            {v.name}
          </Menu.Item>
        ))}
        <Menu.Divider />
        <Group p="xs" gap="xs" wrap="nowrap">
          <TextInput
            size="xs"
            placeholder="Name this view"
            aria-label="View name"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            style={{ flex: 1 }}
          />
          <Button
            size="xs"
            disabled={!name.trim()}
            onClick={() => {
              onSave(name.trim());
              setName('');
            }}
          >
            Save
          </Button>
        </Group>
        <Menu.Item leftSection={<IconLink size={14} />} onClick={onCopyLink}>
          Copy link to this view
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
