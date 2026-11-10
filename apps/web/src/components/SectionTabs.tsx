import { Link, Navigate, Outlet, useLocation } from 'react-router';
import { Box, Tabs } from '@mantine/core';
import { useAuth, useCan } from '../lib/auth';
import { Kicker, Loading } from './ui';
import { categoryForPath, mayOpenAdminPath, tabIsActive, type AdminCategory } from './adminSections';

/** Layout for /admin/*: route-driven tabs (one per page of the category the user may open) above the page itself. */
export function SectionTabs() {
  const { pathname } = useLocation();
  const can = useCan();
  const category = categoryForPath(pathname);
  const tabs = category?.tabs.filter((t) => can(t.area ?? 'admin')) ?? [];
  const current = tabs.find((t) => tabIsActive(pathname, t.path));
  return (
    <>
      {category && tabs.length > 0 && (
        <Box component="nav" aria-label={category.title} mb="md">
          <Kicker mb="2xs">{category.title}</Kicker>
          <Tabs value={current?.path ?? null} keepMounted={false}>
            <Tabs.List>
              {tabs.map((t) => (
                <Tabs.Tab
                  key={t.path}
                  value={t.path}
                  leftSection={t.icon}
                  // A real link: middle-click / open in a new tab work; a plain click is handled by the router.
                  renderRoot={(props) => <Link {...props} to={t.path} />}
                >
                  {t.label}
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs>
        </Box>
      )}
      <Outlet />
    </>
  );
}

/**
 * Route guard of /admin/*: admins, or a delegated role granting the page's tab (or one tab of a category URL); others
 * go home. `tabs={false}` for pages drawn without the section tabs (the workflow editor).
 */
export function AdminRoute({ tabs = true }: Readonly<{ tabs?: boolean }>) {
  const { pathname } = useLocation();
  const { can, loading } = useAuth();
  if (loading) return <Loading />;
  if (!mayOpenAdminPath(pathname, can)) return <Navigate to="/" replace />;
  return tabs ? <SectionTabs /> : <Outlet />;
}

/** Category URL (/admin/model…): the first of its tabs the user may open. */
export function CategoryRedirect({ category }: { category: AdminCategory }) {
  const can = useCan();
  const first = category.tabs.find((t) => can(t.area ?? 'admin'));
  return <Navigate to={first?.path ?? '/'} replace />;
}
