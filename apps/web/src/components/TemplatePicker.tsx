import { useMemo, useState, type ReactNode } from 'react';
import { Badge, Card, Center, Group, Modal, SimpleGrid, Stack, Text, TextInput, UnstyledButton } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { EntityIcon } from './icons';
import { Kicker } from './ui';

/** Square slot (px) of a template's logo: a 26px image or a Tabler icon, centered. */
const ICON_SLOT = 28;

export interface PickerItem {
  label: string;
  /** Vendor / icon name (components/icons) or a ready-made node. */
  icon?: string | ReactNode;
  description?: string;
  group?: string;
  keywords?: string[];
  badge?: string;
}

/** Modal grid of selectable cards (logo, title, one-line description), grouped and searchable. */
export function TemplatePicker<T extends PickerItem>({
  opened,
  title,
  items,
  onClose,
  onPick,
}: {
  opened: boolean;
  title: string;
  items: T[];
  onClose: () => void;
  onPick: (item: T) => void;
}) {
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const shown = items.filter(
      (t) => !needle || [t.label, t.description ?? '', t.group ?? '', ...(t.keywords ?? [])].some((s) => s.toLowerCase().includes(needle)),
    );
    const out = new Map<string, T[]>();
    for (const t of shown) out.set(t.group ?? '', [...(out.get(t.group ?? '') ?? []), t]);
    return [...out.entries()];
  }, [items, q]);

  return (
    <Modal opened={opened} onClose={onClose} title={title} size="xl" trapFocus>
      <Stack>
        <TextInput
          data-autofocus
          placeholder="Search…"
          aria-label="Search"
          leftSection={<IconSearch size={16} />}
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
        />
        {groups.length === 0 && (
          <Text c="dimmed" fz="sm">
            Nothing matches “{q}”.
          </Text>
        )}
        {groups.map(([group, list]) => (
          <Stack key={group} gap="xs">
            {group && <Kicker>{group}</Kicker>}
            <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="sm">
              {list.map((t) => (
                <UnstyledButton key={t.label} onClick={() => onPick(t)} aria-label={t.label} display="block">
                  <Card withBorder padding="sm" className="hover-card" h="100%">
                    <Group gap="sm" wrap="nowrap" align="flex-start">
                      <Center component="span" w={ICON_SLOT} h={ICON_SLOT} flex="none">
                        {typeof t.icon === 'string' ? <EntityIcon name={t.icon} size={26} /> : t.icon}
                      </Center>
                      <div className="min-w-0">
                        <Group gap="2xs" wrap="nowrap">
                          <Text fz="sm" fw={600}>
                            {t.label}
                          </Text>
                          {t.badge && (
                            <Badge size="xs" variant="light" color="gray">
                              {t.badge}
                            </Badge>
                          )}
                        </Group>
                        {t.description && (
                          <Text fz="xs" c="dimmed" lineClamp={2}>
                            {t.description}
                          </Text>
                        )}
                      </div>
                    </Group>
                  </Card>
                </UnstyledButton>
              ))}
            </SimpleGrid>
          </Stack>
        ))}
      </Stack>
    </Modal>
  );
}
