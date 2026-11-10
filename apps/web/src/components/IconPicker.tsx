import { useState } from 'react';
import {
  ActionIcon,
  Box,
  Button,
  CloseButton,
  FileButton,
  Group,
  Input,
  Popover,
  ScrollArea,
  SimpleGrid,
  Stack,
  Tabs,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { IconChevronDown, IconPhoto, IconSearch, IconUpload } from '@tabler/icons-react';
import { EntityIcon, iconTitle, isImageIcon, PICKER_GROUPS } from './icons';
import { Caption } from './ui';

/** Uploaded icons are stored inline (data URI) in the definition: keep them small. */
export const MAX_ICON_BYTES = 48 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];

/** Reads an uploaded image as a data URI, or explains why it cannot be used. */
export function readIconFile(file: File): Promise<string> {
  if (!IMAGE_TYPES.includes(file.type)) return Promise.reject(new Error('Use a PNG, JPEG, GIF, WebP or SVG image'));
  if (file.size > MAX_ICON_BYTES) return Promise.reject(new Error(`Image too large (${Math.ceil(file.size / 1024)} KB, max 48 KB)`));
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('Cannot read the file'));
    r.readAsDataURL(file);
  });
}

const label = (v: string | null) => (!v ? 'Default' : v.startsWith('data:') ? 'Uploaded image' : isImageIcon(v) ? 'Image URL' : iconTitle(v));

/**
 * Icon field of blueprints and actions: pick a built-in icon, or use a custom image (https URL or upload).
 */
export function IconPicker({
  value,
  onChange,
  label: fieldLabel = 'Icon',
  description,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  label?: string;
  description?: string;
}) {
  const [opened, setOpened] = useState(false);
  const [tab, setTab] = useState<string | null>(isImageIcon(value) ? 'custom' : 'icons');
  const [search, setSearch] = useState('');
  const [url, setUrl] = useState(value && isImageIcon(value) && !value.startsWith('data:') ? value : '');
  const [error, setError] = useState<string | null>(null);

  const pick = (v: string | null) => {
    onChange(v);
    setOpened(false);
    setError(null);
  };
  const s = search.trim().toLowerCase();
  const groups = PICKER_GROUPS.map((g) => ({ ...g, icons: g.icons.filter((i) => !s || i.name.includes(s) || i.title.toLowerCase().includes(s)) })).filter(
    (g) => g.icons.length,
  );

  return (
    <Input.Wrapper label={fieldLabel} description={description}>
      <Popover opened={opened} onChange={setOpened} position="bottom-start" width={380} shadow="lg" trapFocus>
        <Popover.Target>
          <Group gap="2xs" wrap="nowrap">
            <UnstyledButton onClick={() => setOpened((o) => !o)} aria-label="Choose an icon" className="icon-picker-button">
              <EntityIcon name={value} size={18} />
              <Text fz="sm" truncate flex={1} c={value ? undefined : 'dimmed'}>
                {label(value)}
              </Text>
              <IconChevronDown size={14} color="var(--text-3)" />
            </UnstyledButton>
            {value && <CloseButton onClick={() => pick(null)} aria-label="Reset icon" />}
          </Group>
        </Popover.Target>
        <Popover.Dropdown p="xs">
          <Tabs value={tab} onChange={setTab}>
            <Tabs.List mb="xs">
              <Tabs.Tab value="icons">Icons</Tabs.Tab>
              <Tabs.Tab value="custom" leftSection={<IconPhoto size={14} />}>
                Custom image
              </Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="icons">
              <TextInput
                size="xs"
                placeholder="Search icons and services"
                leftSection={<IconSearch size={14} />}
                value={search}
                onChange={(e) => setSearch(e.currentTarget.value)}
                mb="xs"
                data-autofocus
              />
              <ScrollArea.Autosize mah={280}>
                <Stack gap="xs">
                  {groups.map((g) => (
                    <div key={g.label}>
                      <Caption fw={500} mb="3xs">
                        {g.label}
                      </Caption>
                      <SimpleGrid cols={8} spacing="3xs" verticalSpacing="3xs">
                        {g.icons.map(({ name: n, title }) => (
                          <Tooltip key={n} label={title} openDelay={400}>
                            <ActionIcon
                              variant={value === n ? 'light' : 'subtle'}
                              color={value === n ? 'brand' : 'gray'}
                              size="lg"
                              onClick={() => pick(n)}
                              aria-label={title}
                            >
                              <EntityIcon name={n} size={18} />
                            </ActionIcon>
                          </Tooltip>
                        ))}
                      </SimpleGrid>
                    </div>
                  ))}
                  {!groups.length && (
                    <Text fz="sm" c="dimmed" ta="center" py="md">
                      No icon matches “{search}”
                    </Text>
                  )}
                </Stack>
              </ScrollArea.Autosize>
            </Tabs.Panel>
            <Tabs.Panel value="custom">
              <Stack gap="sm">
                <Group gap="xs" align="flex-end" wrap="nowrap">
                  <TextInput
                    size="xs"
                    label="Image URL"
                    placeholder="https://example.com/logo.svg"
                    value={url}
                    onChange={(e) => setUrl(e.currentTarget.value)}
                    flex={1}
                  />
                  <Button
                    size="xs"
                    variant="default"
                    onClick={() => (/^https:\/\/\S+$/.test(url.trim()) ? pick(url.trim()) : setError('Enter an https:// URL'))}
                  >
                    Use
                  </Button>
                </Group>
                <Text fz="xs" c="dimmed" ta="center">
                  or
                </Text>
                <FileButton
                  accept={IMAGE_TYPES.join(',')}
                  onChange={(file) => {
                    if (!file) return;
                    readIconFile(file).then(pick, (e: Error) => setError(e.message));
                  }}
                >
                  {(p) => (
                    <Button {...p} size="xs" variant="light" leftSection={<IconUpload size={14} />} fullWidth>
                      Upload an image
                    </Button>
                  )}
                </FileButton>
                <Text fz="xs" c="dimmed">
                  PNG, JPEG, GIF, WebP or SVG, up to 48 KB. Square images look best; uploads are stored in the definition.
                </Text>
                {isImageIcon(value) && (
                  <Group gap="xs">
                    <Box p="2xs" bd="1px solid var(--hairline)" bdrs="sm">
                      <EntityIcon name={value} size={32} />
                    </Box>
                    <Text fz="xs" c="dimmed">
                      Current image
                    </Text>
                  </Group>
                )}
                {error && (
                  <Text fz="xs" c="red">
                    {error}
                  </Text>
                )}
              </Stack>
            </Tabs.Panel>
          </Tabs>
        </Popover.Dropdown>
      </Popover>
    </Input.Wrapper>
  );
}
