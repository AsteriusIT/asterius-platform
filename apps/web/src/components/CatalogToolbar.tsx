import { useState } from 'react';
import { ActionIcon, Badge, Button, Checkbox, CloseButton, Group, Menu, NativeSelect, Popover, Select, Stack, TextInput } from '@mantine/core';
import { IconColumns, IconDeviceFloppy, IconFilter, IconLink, IconPencil, IconTrash } from '@tabler/icons-react';
import type { Blueprint, SavedCatalogView, TeamRef } from '@asterius/shared';
import { ICON } from './iconScale';

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
          <Button variant="default" leftSection={<IconFilter size={ICON.md} />} onClick={() => setOpen((o) => !o)} disabled={!props.length}>
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

/** Choose which property columns the table shows (saved per blueprint in the user's preferences by the caller). */
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
          <IconColumns size={ICON.lg} />
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

/**
 * Saved views: named catalog URL states stored on the server, private or shared with one of the user's teams. The
 * list holds the user's views and those shared with their teams (marked with the team). Saving under the name of one
 * of my views updates it (query and sharing); the pencil loads a view's name and sharing into the form.
 */
export function ViewsMenu({
  views,
  teams,
  onApply,
  onSave,
  onDelete,
  onCopyLink,
}: {
  views: SavedCatalogView[];
  /** Teams the user may share with. */
  teams: TeamRef[];
  onApply: (v: SavedCatalogView) => void;
  onSave: (name: string, team: string | null) => void;
  onDelete: (v: SavedCatalogView) => void;
  onCopyLink: () => void;
}) {
  const [name, setName] = useState('');
  const [team, setTeam] = useState('');
  const mine = views.filter((v) => v.mine);
  const shared = views.filter((v) => !v.mine);
  const existing = mine.find((v) => v.name === name.trim());
  const item = (v: SavedCatalogView) => (
    <Menu.Item
      key={v.id}
      onClick={() => onApply(v)}
      title={v.mine ? undefined : `Shared by ${v.owner.name}`}
      rightSection={
        <Group gap="3xs" wrap="nowrap">
          {v.team && (
            <Badge size="xs" variant="light" tt="none">
              {v.team.title}
            </Badge>
          )}
          {v.mine && (
            <ActionIcon
              size="sm"
              variant="subtle"
              aria-label={`Edit view ${v.name}`}
              onClick={(e) => {
                e.stopPropagation();
                setName(v.name);
                setTeam(v.team?.identifier ?? '');
              }}
            >
              <IconPencil size={ICON.sm} />
            </ActionIcon>
          )}
          {v.canEdit && (
            <ActionIcon
              size="sm"
              variant="subtle"
              color="red"
              aria-label={`Delete view ${v.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(v);
              }}
            >
              <IconTrash size={ICON.sm} />
            </ActionIcon>
          )}
        </Group>
      }
    >
      {v.name}
    </Menu.Item>
  );
  const shareOptions = [
    { value: '', label: 'Only me' },
    ...teams.map((t) => ({ value: t.identifier, label: `Share with ${t.title}` })),
    // Keep the team a view is already shared with selectable even if the user left it.
    ...(existing?.team && !teams.some((t) => t.identifier === existing.team?.identifier)
      ? [{ value: existing.team.identifier, label: `Share with ${existing.team.title}` }]
      : []),
  ];
  return (
    <Menu position="bottom-end" width={300} closeOnItemClick={false}>
      <Menu.Target>
        <Button variant="default" leftSection={<IconDeviceFloppy size={ICON.md} />}>
          Views
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        {views.length === 0 && <Menu.Label>No saved views</Menu.Label>}
        {mine.length > 0 && <Menu.Label>My views</Menu.Label>}
        {mine.map(item)}
        {shared.length > 0 && <Menu.Label>Shared with my teams</Menu.Label>}
        {shared.map(item)}
        <Menu.Divider />
        <Stack p="xs" gap="xs">
          <TextInput
            size="xs"
            placeholder="Name this view"
            aria-label="View name"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            maxLength={100}
          />
          <Group gap="xs" wrap="nowrap">
            <NativeSelect size="xs" aria-label="Share with" data={shareOptions} value={team} onChange={(e) => setTeam(e.currentTarget.value)} flex={1} />
            <Button
              size="xs"
              disabled={!name.trim()}
              onClick={() => {
                onSave(name.trim(), team || null);
                setName('');
                setTeam('');
              }}
            >
              {existing ? 'Update' : 'Save'}
            </Button>
          </Group>
        </Stack>
        <Menu.Item leftSection={<IconLink size={ICON.sm} />} onClick={onCopyLink}>
          Copy link to this view
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
