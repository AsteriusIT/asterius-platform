import { Outlet, useLocation, useNavigate } from 'react-router';
import { Tabs, Text } from '@mantine/core';
import { categoryForPath, tabIsActive } from './adminSections';

/** Layout for /admin/*: route-driven tabs (one per page of the category) above the page itself. */
export function SectionTabs() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const category = categoryForPath(pathname);
  const current = category?.tabs.find((t) => tabIsActive(pathname, t.path));
  return (
    <>
      {category && (
        <nav aria-label={category.title} style={{ marginBottom: 'var(--mantine-spacing-md)' }}>
          <Text fz="xs" fw={600} tt="uppercase" c="dimmed" mb={6}>
            {category.title}
          </Text>
          <Tabs value={current?.path ?? null} onChange={(p) => p && void navigate(p)} keepMounted={false}>
            <Tabs.List>
              {category.tabs.map((t) => (
                <Tabs.Tab key={t.path} value={t.path} leftSection={t.icon}>
                  {t.label}
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs>
        </nav>
      )}
      <Outlet />
    </>
  );
}
