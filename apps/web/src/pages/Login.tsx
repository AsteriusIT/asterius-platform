import { useEffect, useState } from 'react';
import { Alert, Anchor, Button, Center, Divider, Paper, PasswordInput, Stack, Text, TextInput, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';
import { IconBrandGithub, IconBrandWindows, IconKey } from '@tabler/icons-react';
import { api, errorText } from '../lib/api';
import { useAuth } from '../lib/auth';

export function Login() {
  const meta = useQuery({ queryKey: ['meta'], queryFn: api.meta });
  const { user, signIn } = useAuth();
  const [params] = useSearchParams();
  const location = useLocation();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(params.get('error'));
  const [busy, setBusy] = useState(false);
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  if (user) return <Navigate to={from} replace />;
  const providers = meta.data?.authProviders ?? [];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = mode === 'login' ? await api.login(email, password) : await api.register(email, name, password);
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
          <Stack gap={4} align="center">
            <img src="/favicon.svg" width={44} height={44} alt="" />
            <Title order={3}>Asterius Platform</Title>
            <Text c="dimmed" fz="sm">
              Catalog · Self-service · Automation
            </Text>
          </Stack>
          {error && (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          )}
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
          {providers.includes('local') && providers.some((p) => p !== 'local') && <Divider label="or" />}
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
                <Button type="submit" loading={busy}>
                  {mode === 'login' ? 'Sign in' : 'Create account'}
                </Button>
              </Stack>
            </form>
          )}
          {meta.data?.allowRegistration && (
            <Text fz="sm" ta="center">
              {mode === 'login' ? 'No account? ' : 'Already registered? '}
              <Anchor component="button" type="button" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
                {mode === 'login' ? 'Create one' : 'Sign in'}
              </Anchor>
            </Text>
          )}
        </Stack>
      </Paper>
    </Center>
  );
}

/** Entra ID sign-in lands here with the session token in the URL fragment (never sent to servers). */
export function AuthCallback() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    const h = new URLSearchParams(window.location.hash.slice(1));
    const token = h.get('token');
    const returnTo = h.get('returnTo') ?? '/';
    history.replaceState(null, '', window.location.pathname);
    if (token) signIn(token);
    navigate(token ? (returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/') : '/login?error=Sign-in%20failed', { replace: true });
  }, [signIn, navigate]);
  return null;
}
