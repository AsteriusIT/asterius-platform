import { useEffect } from 'react';
import { Anchor, Button, Stack, Text, Title } from '@mantine/core';
import { Navigate, Outlet, useLocation } from 'react-router';
import { orgStore } from '../lib/api';
import { useAuth } from '../lib/auth';
import { hardNavigate, isOrgScoped, legacyRedirect, loginPath, orgPath, splitOrgPath, urlOrg } from '../lib/orgUrl';
import { BrandLogo } from './Brand';
import { Loading } from './ui';

/**
 * Keeps each page on the right side of the `/o/<slug>` prefix (see lib/orgUrl):
 *  - in an organization tab, pages outside organizations (login, `/platform/…`, `/orgs/new`) and links to another
 *    organization (`/o/<other>/…`) leave the router with a full page load;
 *  - outside organizations, an organization page (old bookmark, link already sent) moves to the default organization;
 *  - an organization the user may not enter shows who they are and where they can go.
 */
export function OrgGate() {
  const location = useLocation();
  const { user, loading, org, notMember } = useAuth();
  const path = location.pathname;
  const rest = path + location.search + location.hash;
  const tabSlug = urlOrg();

  let target: string | null = null;
  if (splitOrgPath(path) || (tabSlug && !isOrgScoped(path))) target = rest;
  else if (tabSlug && notMember && legacyRedirect.from) target = legacyRedirect.from;
  else if (!tabSlug && isOrgScoped(path) && !loading && user && org) target = orgPath(org.slug, rest);

  useEffect(() => {
    if (!target) return;
    // A legacy URL was moved under a remembered organization the user left: forget it, the server picks the default.
    if (target === legacyRedirect.from) orgStore.set(null);
    hardNavigate(target);
  }, [target]);

  if (target) return <Loading />;
  if (tabSlug) return notMember ? <NotMember slug={notMember} /> : <Outlet />;
  if (!isOrgScoped(path)) return <Outlet />;
  if (loading) return <Loading />;
  if (!user) return <Navigate to={loginPath(rest)} replace state={{ from: rest }} />;
  return <Navigate to="/welcome" replace />;
}

/** The URL names an organization the user is not a member of (or one that does not exist). */
export function NotMember({ slug }: { slug: string }) {
  const { user, isSuperadmin, signOut } = useAuth();
  const mine = user?.organizations ?? [];
  return (
    <Stack align="center" justify="center" mih="100vh" p="md">
      <Stack maw={480} w="100%" gap="lg" align="center">
        <BrandLogo size={48} />
        <Title order={3} ta="center">
          {isSuperadmin ? `There is no organization ${slug}` : `You are not a member of ${slug}`}
        </Title>
        <Text c="dimmed" ta="center" fz="sm">
          {isSuperadmin
            ? 'Check the link, or open one of the organizations of the platform.'
            : 'This link belongs to an organization you have no access to. Ask one of its admins for an invitation, or continue in one of yours.'}
        </Text>
        <Stack w="100%" gap="xs">
          {mine.map((o) => (
            <Button key={o.id} component="a" href={orgPath(o.slug)} variant="default" fullWidth>
              {o.name}
            </Button>
          ))}
          {isSuperadmin && (
            <Button component="a" href="/platform/organizations" variant="light" fullWidth>
              All organizations
            </Button>
          )}
          {!mine.length && !isSuperadmin && (
            <Button component="a" href="/welcome" variant="light" fullWidth>
              Create an organization
            </Button>
          )}
        </Stack>
        <Text fz="sm" c="dimmed">
          Signed in as {user?.email}.{' '}
          <Anchor component="button" type="button" fz="sm" onClick={() => void signOut()}>
            Sign out
          </Anchor>
        </Text>
      </Stack>
    </Stack>
  );
}
