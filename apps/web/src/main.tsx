import { lazy, StrictMode, Suspense, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation } from 'react-router';
import '@fontsource-variable/inter';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './styles.css';
import { cssVariablesResolver, theme } from './theme';
import { ApiError } from './lib/api';
import { AuthProvider, useAuth } from './lib/auth';
import { Layout } from './components/Layout';
import { Loading } from './components/ui';
import { AuthCallback, Login } from './pages/Login';
import { Home } from './pages/Home';
import { CatalogList, Search } from './pages/Catalog';
import { EntityPage } from './pages/EntityPage';
import { SelfService } from './pages/SelfService';
import { Approvals, RunPage, Runs } from './pages/Runs';
import { Profile } from './pages/Profile';

// Admin pages are only loaded by admins: separate chunks.
const page = <M,>(load: () => Promise<M>, name: keyof M) => {
  const C = lazy(async () => ({ default: (await load())[name] as ComponentType }));
  return (
    <Suspense fallback={<Loading />}>
      <C />
    </Suspense>
  );
};
const definitions = () => import('./pages/admin/Definitions');
const access = () => import('./pages/admin/Access');
const system = () => import('./pages/admin/System');

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 2,
    },
  },
});

function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <Outlet />;
}

function RequireAdmin() {
  const { isAdmin } = useAuth();
  return isAdmin ? <Outlet /> : <Navigate to="/" replace />;
}

function Root() {
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  );
}

const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      { path: '/login', element: <Login /> },
      { path: '/auth/callback', element: <AuthCallback /> },
      {
        element: <RequireAuth />,
        children: [
          {
            element: <Layout />,
            children: [
              { path: '/', element: <Home /> },
              { path: '/search', element: <Search /> },
              { path: '/catalog/:bp', element: <CatalogList /> },
              { path: '/catalog/:bp/:id', element: <EntityPage /> },
              { path: '/self-service', element: <SelfService /> },
              { path: '/runs', element: <Runs /> },
              { path: '/runs/:id', element: <RunPage /> },
              { path: '/approvals', element: <Approvals /> },
              { path: '/profile', element: <Profile /> },
              {
                path: '/admin',
                element: <RequireAdmin />,
                children: [
                  { path: 'blueprints', element: page(definitions, 'BlueprintsAdmin') },
                  { path: 'actions', element: page(definitions, 'ActionsAdmin') },
                  { path: 'integrations', element: page(definitions, 'IntegrationsAdmin') },
                  { path: 'webhooks', element: page(definitions, 'WebhooksAdmin') },
                  { path: 'teams', element: page(access, 'TeamsAdmin') },
                  { path: 'users', element: page(access, 'UsersAdmin') },
                  { path: 'secrets', element: page(access, 'SecretsAdmin') },
                  { path: 'audit', element: page(system, 'AuditAdmin') },
                  { path: 'config', element: page(system, 'ConfigAdmin') },
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
    <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver} defaultColorScheme="light">
      <QueryClientProvider client={queryClient}>
        <ModalsProvider>
          <Notifications position="top-right" />
          <RouterProvider router={router} />
        </ModalsProvider>
      </QueryClientProvider>
    </MantineProvider>
  </StrictMode>,
);
