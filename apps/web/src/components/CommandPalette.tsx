import { useEffect, useMemo, useState } from 'react';
import { Badge, Group, Kbd, Modal, Stack, Text, TextInput, UnstyledButton } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { IconSearch } from '@tabler/icons-react';
import { api } from '../lib/api';
import type { AdminArea } from '../lib/access';
import { visibleCategories } from './adminSections';

export interface Command {
  id: string;
  label: string;
  hint?: string;
  to: string;
}

/** Fixed navigation commands; admin pages only those the user may open (`true`: all, `false`: none). */
export function navCommands(can: boolean | ((area: AdminArea) => boolean)): Command[] {
  const allowed = typeof can === 'boolean' ? () => can : can;
  const base: Command[] = [
    { id: 'home', label: 'Home', to: '/' },
    { id: 'self-service', label: 'Self-service', hint: 'Run an action', to: '/self-service' },
    { id: 'runs', label: 'Runs', to: '/runs' },
    { id: 'approvals', label: 'Approvals', to: '/approvals' },
    { id: 'profile', label: 'Profile and API tokens', to: '/profile' },
  ];
  const admin: Command[] = visibleCategories(allowed)
    .flatMap((c) => c.tabs)
    .map((t) => ({
      id: `admin-${t.path.split('/').pop()}`,
      label: `Admin: ${t.label}`,
      to: t.path,
    }));
  return [...base, ...admin];
}

/** True when the key event comes from a text field (so single-key shortcuts must not fire). */
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

/**
 * Ctrl/Cmd+K (or "/") palette: jump to pages and, while typing, to catalog entities. Arrow keys move, Enter opens.
 */
export function CommandPalette({
  can,
  opened,
  onOpenChange,
}: {
  /** Admin pages the user may open (see useAuth().can). */
  can: boolean | ((area: AdminArea) => boolean);
  opened: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [debounced] = useDebouncedValue(query.trim(), 200);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpenChange(!opened);
      } else if (e.key === '/' && !typing(e.target) && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        onOpenChange(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [opened, onOpenChange]);

  const entities = useQuery({
    queryKey: ['palette', debounced],
    queryFn: () => api.entities({ search: debounced, limit: 8 }),
    enabled: opened && debounced.length >= 2,
  });

  const items: (Command & { badge?: string })[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const nav = navCommands(can).filter((c) => !q || c.label.toLowerCase().includes(q));
    const found = (entities.data?.items ?? []).map((e) => ({
      id: `${e.blueprint}/${e.identifier}`,
      label: e.title,
      hint: e.identifier,
      badge: e.blueprint,
      to: `/catalog/${e.blueprint}/${encodeURIComponent(e.identifier)}`,
    }));
    return [...found, ...nav];
  }, [query, can, entities.data]);

  useEffect(() => setIndex(0), [items.length, query]);

  const go = (c: Command | undefined) => {
    if (!c) return;
    onOpenChange(false);
    setQuery('');
    void navigate(c.to);
  };

  return (
    <Modal opened={opened} onClose={() => onOpenChange(false)} withCloseButton={false} padding="xs" title="Command palette" size="lg" yOffset="12vh" trapFocus>
      <Stack gap="xs">
        <TextInput
          data-autofocus
          aria-label="Search pages and entities"
          placeholder="Type to search pages and entities"
          leftSection={<IconSearch size={16} />}
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, items.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              go(items[index]);
            }
          }}
          aria-controls="palette-list"
          aria-activedescendant={items[index] ? `palette-${items[index].id}` : undefined}
        />
        <Stack gap={2} id="palette-list" role="listbox" aria-label="Results" mah={360} style={{ overflowY: 'auto' }}>
          {items.length === 0 && (
            <Text c="dimmed" fz="sm" p="sm">
              No match
            </Text>
          )}
          {items.map((c, i) => (
            <UnstyledButton
              key={c.id}
              id={`palette-${c.id}`}
              role="option"
              aria-selected={i === index}
              onClick={() => go(c)}
              onMouseEnter={() => setIndex(i)}
              p="xs"
              style={{ borderRadius: 'var(--mantine-radius-sm)', background: i === index ? 'var(--mantine-primary-color-light)' : undefined }}
            >
              <Group justify="space-between" wrap="nowrap">
                <Text fz="sm" truncate>
                  {c.label}
                  {c.hint && (
                    <Text span c="dimmed" fz="xs" ml="xs">
                      {c.hint}
                    </Text>
                  )}
                </Text>
                {c.badge && (
                  <Badge color="gray" size="sm">
                    {c.badge}
                  </Badge>
                )}
              </Group>
            </UnstyledButton>
          ))}
        </Stack>
        <Group gap="xs" c="dimmed" fz="xs">
          <Kbd size="xs">↑</Kbd>
          <Kbd size="xs">↓</Kbd> navigate <Kbd size="xs">Enter</Kbd> open <Kbd size="xs">Esc</Kbd> close
        </Group>
      </Stack>
    </Modal>
  );
}
