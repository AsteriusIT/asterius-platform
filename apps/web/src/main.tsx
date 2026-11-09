import { lazy, StrictMode, Suspense, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { Notifications } from '@mantine/notifications';
import { QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation } from 'react-router';
import '@fontsource-variable/inter';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './styles.css';
import { cssVariablesResolver, theme } from './theme';
import { createQueryClient } from './lib/queryClient';
import { ErrorBoundary, RouteError } from './components/ErrorBoundary';
import { AuthProvider, useAuth } from './lib/auth';
import { useDocumentBrand } from './components/Brand';
import { SectionTabs } from './components/SectionTabs';
import { ADMIN_CATEGORIES } from './components/adminSections';
import { Layout } from './components/Layout';
import { Loading } from './components/ui';
import { AuthCallback, Login } from './pages/Login';

// Every page is a separate chunk loaded on first visit.
const page = <M,>(load: () => Promise<M>, name: keyof M) => {
  const C = lazy(async () => ({ default: (await load())[name] as ComponentType }));
  return (
    <Suspense fallback={<Loading />}>
      <C />
    </Suspense>
  );
};
const home = () => import('./pages/Home');
const catalog = () => import('./pages/Catalog');
const entity = () => import('./pages/EntityPage');
const selfService = () => import('./pages/SelfService');
const runs = () => import('./pages/Runs');
const profile = () => import('./pages/Profile');
const definitions = () => import('./pages/admin/Definitions');
const workflowFlow = () => import('./pages/admin/WorkflowFlow');
const access = () => import('./pages/admin/Access');
const system = () => import('./pages/admin/System');
const notificationsAdmin = () => import('./pages/admin/Notifications');
const ai = () => import('./pages/admin/AiAdmin');
const organization = () => import('./pages/Organization');

const queryClient = createQueryClient();

function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  // Signed in without an organization: create one or wait for an invitation.
  if (!user.organization && location.pathname !== '/welcome') return <Navigate to="/welcome" replace />;
  return <Outlet />;
}

/** Admin pages without the section tabs (the workflow editor). */
function RequireAdminPage() {
  const { isAdmin } = useAuth();
  return isAdmin ? <Outlet /> : <Navigate to="/" replace />;
}

function RequireAdmin() {
  const { isAdmin } = useAuth();
  return isAdmin ? <SectionTabs /> : <Navigate to="/" replace />;
}

function RequireSuperadmin() {
  const { isSuperadmin } = useAuth();
  return isSuperadmin ? <Outlet /> : <Navigate to="/" replace />;
}

function Root() {
  useDocumentBrand();
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  );
}

const router = createBrowserRouter([
  {
    element: <Root />,
    errorElement: <RouteError />,
    children: [
      { path: '/login', element: <Login /> },
      { path: '/auth/callback', element: <AuthCallback /> },
      {
        element: <RequireAuth />,
        children: [
          { path: '/welcome', element: page(organization, 'Welcome') },
          {
            element: <Layout />,
            errorElement: <RouteError />,
            children: [
              { path: '/', element: page(home, 'Home') },
              { path: '/search', element: page(catalog, 'Search') },
              { path: '/catalog', element: page(catalog, 'CatalogHome') },
              { path: '/catalog/:bp', element: page(catalog, 'CatalogList') },
              { path: '/catalog/:bp/:id', element: page(entity, 'EntityPage') },
              { path: '/self-service', element: page(selfService, 'SelfService') },
              { path: '/runs', element: page(runs, 'Runs') },
              { path: '/runs/:id', element: page(runs, 'RunPage') },
              { path: '/runs/:id/flow', element: page(runs, 'RunFlowPage') },
              {
                // The workflow editor fills the content panel: no admin section tabs.
                element: <RequireAdminPage />,
                children: [
                  { path: '/admin/actions/:id', element: page(workflowFlow, 'WorkflowFlowPage') },
                  { path: '/admin/actions/:id/flow', element: page(workflowFlow, 'WorkflowFlowRedirect') },
                ],
              },
              { path: '/approvals', element: page(runs, 'Approvals') },
              { path: '/profile', element: page(profile, 'Profile') },
              { path: '/orgs/new', element: page(organization, 'NewOrganization') },
              {
                path: '/platform',
                element: <RequireSuperadmin />,
                children: [{ path: 'organizations', element: page(organization, 'PlatformOrganizations') }],
              },
              {
                path: '/admin',
                element: <RequireAdmin />,
                children: [
                  ...ADMIN_CATEGORIES.map((c) => ({ path: c.id, element: <Navigate to={c.tabs[0].path} replace /> })),
                  { path: 'blueprints', element: page(definitions, 'BlueprintsAdmin') },
                  { path: 'actions', element: page(definitions, 'ActionsAdmin') },
                  { path: 'integrations', element: page(definitions, 'IntegrationsAdmin') },
                  { path: 'dashboards', element: page(definitions, 'DashboardsAdmin') },
                  { path: 'scorecards', element: page(definitions, 'ScorecardsAdmin') },
                  { path: 'policies', element: page(definitions, 'PoliciesAdmin') },
                  { path: 'fragments', element: page(definitions, 'FragmentsAdmin') },
                  { path: 'webhooks', element: page(definitions, 'WebhooksAdmin') },
                  { path: 'teams', element: page(access, 'TeamsAdmin') },
                  { path: 'users', element: page(access, 'UsersAdmin') },
                  { path: 'delegations', element: page(access, 'DelegationsAdmin') },
                  { path: 'secrets', element: page(access, 'SecretsAdmin') },
                  { path: 'deleted', element: page(system, 'DeletedAdmin') },
                  { path: 'audit', element: page(system, 'AuditAdmin') },
                  { path: 'ai', element: page(ai, 'AiAdmin') },
                  { path: 'config', element: page(system, 'ConfigAdmin') },
                  { path: 'notifications', element: page(notificationsAdmin, 'NotificationsAdmin') },
                  { path: 'deliveries', element: page(system, 'DeliveriesAdmin') },
                  { path: 'organization', element: page(organization, 'OrganizationSettings') },
                ],
              },
              { path: '*', element: <Navigate to="/" replace /> },
            ],
          },
        ],
      },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver} defaultColorScheme="light">
        <QueryClientProvider client={queryClient}>
          <ModalsProvider>
            <Notifications position="top-right" />
            <RouterProvider router={router} />
          </ModalsProvider>
        </QueryClientProvider>
      </MantineProvider>
    </ErrorBoundary>
  </StrictMode>,
);
