import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, testApp } from './helpers.js';
import { inDefaultOrg } from './helpers.js';

// The fake server binds an OS-assigned port (no random-port collisions with other suites); the URL must be known
// before config.ts is imported, so the socket is opened here and the request handler attached in beforeAll.
const base = await vi.hoisted(async () => {
  const http = await import('node:http');
  const srv = http.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const p = (srv.address() as { port: number }).port;
  const u = `http://127.0.0.1:${p}`;
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-'));
  fs.writeFileSync(path.join(dir, 'sa-jwt'), 'k8s-sa-jwt');
  fs.writeFileSync(path.join(dir, 'web-id'), 'web-identity-jwt');
  fs.writeFileSync(path.join(dir, 'az-fed'), 'azure-federated-jwt');
  Object.assign(process.env, {
    VAULT_ADDR: u,
    VAULT_K8S_ROLE: 'asterius',
    VAULT_K8S_JWT_PATH: path.join(dir, 'sa-jwt'),
    AWS_REGION: 'eu-west-1',
    AWS_ROLE_ARN: 'arn:aws:iam::1:role/asterius',
    AWS_WEB_IDENTITY_TOKEN_FILE: path.join(dir, 'web-id'),
    AWS_STS_ENDPOINT: `${u}/sts`,
    AWS_SECRETSMANAGER_ENDPOINT: `${u}/awssm`,
    AZURE_KEYVAULT_ENABLED: 'true',
    AZURE_KEYVAULT_URL_TEMPLATE: `${u}/azkv/{vault}`,
    AZURE_TENANT_ID: 'tenant',
    AZURE_CLIENT_ID: 'client',
    AZURE_FEDERATED_TOKEN_FILE: path.join(dir, 'az-fed'),
    AZURE_AUTHORITY_HOST: `${u}/azauth`,
    GCP_SECRETMANAGER_ENABLED: 'true',
    GCP_SECRETMANAGER_URL: `${u}/gcpsm`,
    GCP_METADATA_URL: `${u}/gcpmeta`,
    SECRET_CACHE_SECONDS: '0',
  });
  return { srv, port: p, url: u };
});
const hoisted = base;

let server: http.Server;
let app: FastifyInstance;
const hits: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];

beforeAll(async () => {
  server = hoisted.srv;
  server.on('request', (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = req.url ?? '';
      hits.push({ url, headers: req.headers, body });
      const send = (o: unknown, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      if (url === '/v1/auth/kubernetes/login')
        return send(
          JSON.parse(body).jwt === 'k8s-sa-jwt' ? { auth: { client_token: 'vtok', lease_duration: 3600 } } : {},
          JSON.parse(body).jwt === 'k8s-sa-jwt' ? 200 : 403,
        );
      if (url === '/v1/secret/data/payments/db')
        return req.headers['x-vault-token'] === 'vtok' ? send({ data: { data: { password: 'vault-pw', n: 1 } } }) : send({}, 403);
      if (url.startsWith('/sts/'))
        return send({
          AssumeRoleWithWebIdentityResponse: {
            AssumeRoleWithWebIdentityResult: {
              Credentials: { AccessKeyId: 'AKIA', SecretAccessKey: 'sk', SessionToken: 'st', Expiration: Date.now() / 1000 + 3600 },
            },
          },
        });
      if (url === '/awssm') {
        const auth = String(req.headers.authorization);
        if (
          !auth.startsWith('AWS4-HMAC-SHA256 Credential=AKIA/') ||
          !auth.includes('/eu-west-1/secretsmanager/aws4_request') ||
          req.headers['x-amz-security-token'] !== 'st'
        )
          return send({}, 403);
        return send({ SecretString: JSON.parse(body).SecretId === 'prod/db' ? '{"password":"aws-pw"}' : 'plain' });
      }
      if (url === '/azauth/tenant/oauth2/v2.0/token')
        return send(body.includes('azure-federated-jwt') ? { access_token: 'aztok', expires_in: 3600 } : {}, body.includes('azure-federated-jwt') ? 200 : 401);
      if (url.startsWith('/azkv/my-vault/secrets/db-password')) return req.headers.authorization === 'Bearer aztok' ? send({ value: 'az-pw' }) : send({}, 401);
      if (url === '/gcpmeta/computeMetadata/v1/instance/service-accounts/default/token') return send({ access_token: 'gtok', expires_in: 3600 });
      if (url === '/gcpsm/v1/projects/my-project/secrets/db-password/versions/latest:access')
        return req.headers.authorization === 'Bearer gtok' ? send({ payload: { data: Buffer.from('gcp-pw').toString('base64') } }) : send({}, 401);
      send({ error: 'nope' }, 404);
    });
  });
  app = await testApp();
});
afterAll(async () => {
  await app.close();
  server.close();
});

describe('external secret providers', () => {
  it('resolves each provider through workload identity', () =>
    inDefaultOrg(async () => {
      const { resolveRef } = await import('../src/secrets.js');
      expect(await resolveRef('vault', 'secret/payments/db#password')).toBe('vault-pw');
      expect(await resolveRef('awssm', 'prod/db#password')).toBe('aws-pw');
      expect(await resolveRef('awssm', 'plain-secret')).toBe('plain');
      expect(await resolveRef('azkv', 'my-vault/db-password')).toBe('az-pw');
      expect(await resolveRef('gcpsm', 'my-project/db-password')).toBe('gcp-pw');
    }));

  it('works inside templates and single-value references', () =>
    inDefaultOrg(async () => {
      const { render } = await import('../src/lib/expr.js');
      const { resolveRef, resolveValue } = await import('../src/secrets.js');
      const r = await render({ h: 'Bearer ${vault:secret/payments/db#password}' }, {}, resolveRef);
      expect(r.value).toEqual({ h: 'Bearer vault-pw' });
      expect(r.secrets).toEqual(['vault-pw']); // registered for log redaction
      expect(await resolveValue('${gcpsm:my-project/db-password}')).toBe('gcp-pw');
    }));

  it('rejects traversal, unknown keys, disallowed kubernetes namespaces and unconfigured providers', () =>
    inDefaultOrg(async () => {
      const { resolveRef } = await import('../src/secrets.js');
      await expect(resolveRef('vault', 'secret/../sys/x#k')).rejects.toThrow(/Invalid vault reference/);
      await expect(resolveRef('vault', 'secret/payments/db#missing')).rejects.toThrow(/not found/);
      await expect(resolveRef('azkv', '../evil/x')).rejects.toThrow(/Invalid/);
      await expect(resolveRef('k8s', 'kube-system/token/value')).rejects.toThrow(/not configured|not allowed/);
      await expect(resolveRef('nosuch', 'x')).rejects.toThrow(); // falls through to the database secrets: not defined
    }));

  it('does not leak provider responses into errors', async () => {
    const { resolveRef } = await import('../src/secrets.js');
    await expect(resolveRef('vault', 'secret/other/path#k')).rejects.not.toThrow(/nope/);
  });

  it('lists providers for the admin page', async () => {
    const admin = client(app, (await register(app, 'admin@example.com')).token);
    const list = (await admin.get('/api/v1/secret-providers')).data as { kind: string; enabled: boolean }[];
    expect(list.map((p) => [p.kind, p.enabled])).toEqual([
      ['vault', true],
      ['awssm', true],
      ['azkv', true],
      ['gcpsm', true],
      ['k8s', false],
    ]);
    expect(fs.existsSync(path.join(os.tmpdir()))).toBe(true);
  });
});

describe('SigV4', () => {
  it('produces a stable, scoped signature', async () => {
    const { signV4 } = await import('../src/secret-providers/aws.js');
    const args = {
      host: 'secretsmanager.eu-west-1.amazonaws.com',
      region: 'eu-west-1',
      service: 'secretsmanager',
      target: 'secretsmanager.GetSecretValue',
      body: '{"SecretId":"x"}',
      amzDate: '20260101T000000Z',
      creds: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
    };
    const a = signV4(args);
    expect(a.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260101\/eu-west-1\/secretsmanager\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=[0-9a-f]{64}$/,
    );
    expect(signV4(args).authorization).toBe(a.authorization);
    expect(signV4({ ...args, body: '{"SecretId":"y"}' }).authorization).not.toBe(a.authorization);
  });
});
