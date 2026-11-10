import { useEffect, useState } from 'react';
import { Alert, Anchor, Button, Center, Divider, Paper, PasswordInput, Stack, Text, TextInput, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';
import { IconBrandGithub, IconBrandWindows, IconKey, IconShieldLock } from '@tabler/icons-react';
import { api, errorText } from '../lib/api';
import { useAuth } from '../lib/auth';
import { safeReturnTo } from '../lib/orgUrl';
import { BrandLogo, useBrand } from '../components/Brand';

export function Login() {
  const meta = useQuery({ queryKey: ['meta'], queryFn: api.meta });
  const { user, signIn } = useAuth();
  const brand = useBrand();
  const [params] = useSearchParams();
  const location = useLocation();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [bootstrapToken, setBootstrapToken] = useState('');
  const [ssoEmail, setSsoEmail] = useState('');
  const [error, setError] = useState<string | null>(params.get('error'));
  const [busy, setBusy] = useState(false);
  // Where to go once signed in: a full path (`/o/<slug>/…` for an organization page), from the router or the URL.
  const from = (location.state as { from?: string } | null)?.from ?? safeReturnTo(params.get('returnTo')) ?? '/';

  if (user) return <Navigate to={from} replace />;
  const providers = meta.data?.authProviders ?? [];
  // Three stacked sections (Keycloak SSO, provider buttons, local form): one "or" between two present sections.
  const hasButtons = (['entra', 'oidc', 'saml', 'github'] as const).some((p) => providers.includes(p));
  const hasKeycloak = providers.includes('keycloak');
  const hasLocal = providers.includes('local');
  const keycloakUrl = (o: { email?: string; register?: boolean }) => {
    const p = new URLSearchParams({ returnTo: from });
    if (o.email?.includes('@')) p.set('email', o.email.trim());
    if (o.register) p.set('register', '1');
    return `/api/auth/keycloak/login?${p}`;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = mode === 'login' ? await api.login(email, password) : await api.register(email, name, password, bootstrapToken.trim() || undefined);
      signIn(r.token);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Center mih="100vh" p="md" bg="var(--mantine-color-body)">
      <Paper w="100%" maw={380} p="xl" shadow="none" bg="transparent">
        <Stack>
          <Stack gap="3xs" align="center">
            <BrandLogo size={48} />
            <Title order={3} ta="center">
              {brand.name}
            </Title>
            <Text c="dimmed" fz="sm">
              Catalog · Self-service · Automation
            </Text>
          </Stack>
          {error && (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          )}
          {providers.includes('keycloak') && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                window.location.assign(keycloakUrl({ email: ssoEmail }));
              }}
            >
              <Stack gap="xs">
                <TextInput
                  type="email"
                  placeholder="Work email (optional)"
                  value={ssoEmail}
                  onChange={(e) => setSsoEmail(e.currentTarget.value)}
                  autoComplete="email"
                  aria-label="Work email"
                  description="Your company's sign-in opens when your organization has connected it"
                />
                <Button type="submit" leftSection={<IconShieldLock size={18} />}>
                  Continue with SSO
                </Button>
              </Stack>
            </form>
          )}
          {hasKeycloak && (hasButtons || hasLocal) && <Divider label="or" />}
          {providers.includes('entra') && (
            <Button
              component="a"
              href={`/api/auth/entra/login?returnTo=${encodeURIComponent(from)}`}
              variant="default"
              leftSection={<IconBrandWindows size={18} />}
            >
              Continue with Microsoft
            </Button>
          )}
          {providers.includes('oidc') && (
            <Button component="a" href={`/api/auth/oidc/login?returnTo=${encodeURIComponent(from)}`} variant="default" leftSection={<IconKey size={18} />}>
              Continue with {meta.data?.oidcTitle ?? 'SSO'}
            </Button>
          )}
          {providers.includes('saml') && (
            <Button component="a" href={`/api/auth/saml/login?returnTo=${encodeURIComponent(from)}`} variant="default" leftSection={<IconKey size={18} />}>
              Continue with {meta.data?.samlTitle ?? 'SAML SSO'}
            </Button>
          )}
          {providers.includes('github') && (
            <Button
              component="a"
              href={`/api/auth/github/login?returnTo=${encodeURIComponent(from)}`}
              variant="default"
              leftSection={<IconBrandGithub size={18} />}
            >
              Continue with GitHub
            </Button>
          )}
          {hasLocal && hasButtons && <Divider label="or" />}
          {providers.includes('local') && (
            <form onSubmit={submit}>
              <Stack gap="sm">
                {mode === 'register' && <TextInput label="Name" required value={name} onChange={(e) => setName(e.currentTarget.value)} autoComplete="name" />}
                <TextInput label="Email" type="email" required value={email} onChange={(e) => setEmail(e.currentTarget.value)} autoComplete="email" />
                <PasswordInput
                  label="Password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.currentTarget.value)}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  description={mode === 'register' ? 'At least 10 characters' : undefined}
                />
                {mode === 'register' && (
                  <TextInput
                    label="Bootstrap token"
                    description="Only for the very first administrator (BOOTSTRAP_TOKEN); leave empty otherwise"
                    value={bootstrapToken}
                    onChange={(e) => setBootstrapToken(e.currentTarget.value)}
                    autoComplete="off"
                  />
                )}
                <Button type="submit" loading={busy}>
                  {mode === 'login' ? 'Sign in' : 'Create account'}
                </Button>
              </Stack>
            </form>
          )}
          {providers.includes('keycloak') && !providers.includes('local') && (
            <Text fz="sm" ta="center">
              No account?{' '}
              <Anchor href={keycloakUrl({ register: true })} fz="inherit">
                Create one
              </Anchor>
            </Text>
          )}
          {meta.data?.allowRegistration && providers.includes('local') && (
            <Text fz="sm" ta="center">
              {mode === 'login' ? 'No account? ' : 'Already registered? '}
              <Anchor component="button" type="button" fz="inherit" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
                {mode === 'login' ? 'Create one' : 'Sign in'}
              </Anchor>
            </Text>
          )}
        </Stack>
      </Paper>
    </Center>
  );
}

/** Entra ID and Keycloak sign-ins land here with the session token in the URL fragment (never sent to servers). */
export function AuthCallback() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    const h = new URLSearchParams(window.location.hash.slice(1));
    const token = h.get('token');
    const returnTo = h.get('returnTo') ?? '/';
    history.replaceState(null, '', window.location.pathname);
    if (token) signIn(token);
    navigate(token ? (safeReturnTo(returnTo) ?? '/') : '/login?error=Sign-in%20failed', { replace: true });
  }, [signIn, navigate]);
  return null;
}
