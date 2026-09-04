import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

function json(res, value) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

function passwordHash(password) {
  const salt = crypto.randomBytes(16);
  const digest = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${digest.toString('base64url')}`;
}

async function waitForHealth(baseUrl, child, output) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`proxy exited early (${child.exitCode})\n${output()}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`proxy did not become healthy\n${output()}`);
}

async function startProxy(config) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'commandcode-proxy-test-'));
  copyFileSync(path.join(projectRoot, 'proxy.mjs'), path.join(directory, 'proxy.mjs'));
  writeFileSync(path.join(directory, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  let output = '';
  const child = spawn(process.execPath, ['proxy.mjs'], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const baseUrl = `http://127.0.0.1:${config.port}`;
  await waitForHealth(baseUrl, child, () => output);
  return {
    baseUrl,
    output: () => output,
    async close() {
      if (child.exitCode === null) {
        child.kill();
        await new Promise(resolve => child.once('exit', resolve));
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('usage dashboard loads immediately and admin session survives the login response', async t => {
  const upstream = http.createServer(async (req, res) => {
    if (req.url.startsWith('/alpha/whoami')) {
      await new Promise(resolve => setTimeout(resolve, 1200));
      return json(res, { org: { id: 'org_test' } });
    }
    if (req.url.startsWith('/alpha/billing/credits')) {
      return json(res, { credits: { planId: 'individual-go', monthlyCredits: 8, purchasedCredits: 0, freeCredits: 0, windowLimits: { fiveHour: { used: 1, cap: 5 }, weekly: { used: 2, cap: 20 } } } });
    }
    if (req.url.startsWith('/alpha/billing/subscriptions')) {
      return json(res, { data: { planId: 'individual-go', currentPeriodStart: '2026-09-01T00:00:00.000Z', currentPeriodEnd: '2026-10-01T00:00:00.000Z' } });
    }
    if (req.url.startsWith('/alpha/usage/summary')) {
      await new Promise(resolve => setTimeout(resolve, 300));
      return json(res, { totalCount: 9, totalTokens: 1234, totalCost: 2 });
    }
    res.writeHead(404).end();
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  const port = await freePort();
  const password = 'test-password-only';
  const proxy = await startProxy({
    port,
    host: '127.0.0.1',
    apiKey: '',
    apiBase: `http://127.0.0.1:${upstreamPort}`,
    usageAllowedIps: ['127.0.0.1'],
    adminAuth: {
      enabled: true,
      passwordHash: passwordHash(password),
      allowedIps: ['127.0.0.1'],
      trustedProxyIps: [],
      sessionTtlMinutes: 30,
      secureCookie: false,
    },
    accountPool: {
      enabled: true,
      proxyKey: 'test-proxy-key-at-least-24-characters',
      usageRefreshIntervalMs: 60000,
      selectionStrategy: 'priority',
      accounts: [{ id: 'account-1', alias: '测试账号', priority: 1, apiKey: 'user_test_key_do_not_use', enabled: true }],
    },
  });
  t.after(() => proxy.close());

  const modelsStartedAt = Date.now();
  const modelsResponse = await fetch(`${proxy.baseUrl}/v1/models`, { headers: { Authorization: 'Bearer test-proxy-key-at-least-24-characters' } });
  assert.equal(modelsResponse.status, 200);
  assert.ok(Date.now() - modelsStartedAt < 800, 'proxy routing must not wait for the delayed usage endpoint');

  const startedAt = Date.now();
  const htmlResponse = await fetch(`${proxy.baseUrl}/usage`, { headers: { Accept: 'text/html' } });
  const html = await htmlResponse.text();
  assert.equal(htmlResponse.status, 200);
  assert.ok(Date.now() - startedAt < 800, 'HTML response must not wait for the delayed upstream');
  assert.match(html, /正在后台刷新/);
  assert.doesNotMatch(html, /user_test_key|test-proxy-key/);
  assert.equal(htmlResponse.headers.get('access-control-allow-origin'), null);
  const dashboardScript = html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)?.[1];
  assert.ok(dashboardScript);
  assert.doesNotThrow(() => new Function(dashboardScript));
  assert.doesNotMatch(htmlResponse.headers.get('content-security-policy'), /script-src 'unsafe-inline'/);

  let usage;
  const usageDeadline = Date.now() + 6000;
  do {
    const response = await fetch(`${proxy.baseUrl}/usage?format=json&async=1`);
    usage = await response.json();
    if (!usage.refreshing) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < usageDeadline);
  assert.equal(usage.refreshing, false, proxy.output());
  assert.equal(usage.accounts[0].status, 'ok');
  assert.equal(usage.accounts[0].fiveHour.used, 1);
  assert.equal(usage.accounts[0].weekly.used, 2);
  assert.equal(usage.accounts[0].monthly.remaining, 8);
  assert.doesNotMatch(JSON.stringify(usage), /user_test_key|test-proxy-key/);

  const adminPageResponse = await fetch(`${proxy.baseUrl}/admin`);
  const adminPage = await adminPageResponse.text();
  assert.equal(adminPageResponse.status, 200);
  assert.equal(adminPageResponse.headers.get('access-control-allow-origin'), null);
  assert.doesNotMatch(adminPageResponse.headers.get('content-security-policy'), /script-src 'unsafe-inline'/);
  assert.doesNotThrow(() => new Function(adminPage.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1]));

  const forgedStateResponse = await fetch(`${proxy.baseUrl}/api/admin/state`, {
    headers: {
      Authorization: 'Bearer test-proxy-key-at-least-24-characters',
      Cookie: `cc_proxy_admin=${crypto.randomBytes(32).toString('base64url')}`,
      'X-Forwarded-For': '127.0.0.1',
    },
  });
  assert.equal(forgedStateResponse.status, 401);
  assert.equal(forgedStateResponse.headers.get('cache-control'), 'no-store');
  assert.equal(forgedStateResponse.headers.get('access-control-allow-origin'), null);

  for (const pathVariant of ['/api/admin/state/', '/api/admin/%73tate']) {
    const pathResponse = await fetch(`${proxy.baseUrl}${pathVariant}`);
    assert.equal(pathResponse.status, 404);
  }

  const unsupportedLoginResponse = await fetch(`${proxy.baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password, role: 'admin' }),
  });
  assert.equal(unsupportedLoginResponse.status, 400);

  const loginResponse = await fetch(`${proxy.baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  assert.equal(loginResponse.status, 200);
  const cookie = loginResponse.headers.get('set-cookie').split(';', 1)[0];
  assert.match(loginResponse.headers.get('set-cookie'), /Path=\/api\/admin; HttpOnly; SameSite=Strict/);
  assert.equal(loginResponse.headers.get('cache-control'), 'no-store');
  const loginState = await loginResponse.json();
  const stateResponse = await fetch(`${proxy.baseUrl}/api/admin/state`, { headers: { Cookie: cookie } });
  assert.equal(stateResponse.status, 200);
  assert.doesNotMatch(await stateResponse.text(), /user_test_key|test-proxy-key/);

  const csrfResponse = await fetch(`${proxy.baseUrl}/api/admin/account-pool`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': 'wrong' },
    body: JSON.stringify({}),
  });
  assert.equal(csrfResponse.status, 403);
  assert.ok(loginState.csrfToken);

  const saveResponse = await fetch(`${proxy.baseUrl}/api/admin/account-pool`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': loginState.csrfToken },
    body: JSON.stringify({
      enabled: true,
      proxyKey: '',
      selectionStrategy: 'priority',
      usageRefreshIntervalMs: 60000,
      accounts: [{ id: 'account-1', alias: '新别名', priority: 1, enabled: true, apiKey: '' }],
    }),
  });
  assert.equal(saveResponse.status, 200, await saveResponse.text());
  const savedState = await (await fetch(`${proxy.baseUrl}/api/admin/state`, { headers: { Cookie: cookie } })).json();
  assert.equal(savedState.accountPool.accounts[0].alias, '新别名');
  assert.equal(savedState.accountPool.accounts[0].hasApiKey, true);
  assert.doesNotMatch(JSON.stringify(savedState), /user_test_key|test-proxy-key/);
});

test('secure admin cookie refuses an untrusted plain HTTP login', async t => {
  const port = await freePort();
  const proxy = await startProxy({
    port,
    host: '127.0.0.1',
    apiBase: 'http://127.0.0.1:1',
    usageAllowedIps: ['127.0.0.1'],
    adminAuth: {
      enabled: true,
      passwordHash: passwordHash('test-password-only'),
      allowedIps: ['127.0.0.1'],
      trustedProxyIps: [],
      sessionTtlMinutes: 30,
      secureCookie: true,
    },
    accountPool: { enabled: false },
  });
  t.after(() => proxy.close());
  const response = await fetch(`${proxy.baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
    body: JSON.stringify({ password: 'test-password-only' }),
  });
  assert.equal(response.status, 426);
  assert.equal((await response.json()).error.type, 'https_required');
});

test('secure admin cookie accepts HTTPS metadata from an exact trusted proxy', async t => {
  const port = await freePort();
  const password = 'test-password-only';
  const proxy = await startProxy({
    port,
    host: '127.0.0.1',
    apiBase: 'http://127.0.0.1:1',
    usageAllowedIps: ['127.0.0.1'],
    adminAuth: {
      enabled: true,
      passwordHash: passwordHash(password),
      allowedIps: ['*'],
      trustedProxyIps: ['127.0.0.1'],
      sessionTtlMinutes: 30,
      secureCookie: true,
    },
    accountPool: { enabled: false },
  });
  t.after(() => proxy.close());
  const response = await fetch(`${proxy.baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
    body: JSON.stringify({ password }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /; Secure$/);
});

test('forwarded client IP cannot bypass the direct-peer admin allowlist', async t => {
  const port = await freePort();
  const proxy = await startProxy({
    port,
    host: '127.0.0.1',
    apiBase: 'http://127.0.0.1:1',
    usageAllowedIps: ['*'],
    adminAuth: {
      enabled: true,
      passwordHash: passwordHash('test-password-only'),
      allowedIps: ['203.0.113.10'],
      trustedProxyIps: ['127.0.0.1'],
      sessionTtlMinutes: 30,
      secureCookie: true,
    },
    accountPool: { enabled: false },
  });
  t.after(() => proxy.close());

  const pageResponse = await fetch(`${proxy.baseUrl}/admin`, {
    headers: { 'X-Forwarded-For': '203.0.113.10' },
  });
  assert.equal(pageResponse.status, 403);

  const loginResponse = await fetch(`${proxy.baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '203.0.113.10',
      'X-Forwarded-Proto': 'https',
    },
    body: JSON.stringify({ password: 'test-password-only' }),
  });
  assert.equal(loginResponse.status, 403);
  assert.equal(loginResponse.headers.get('set-cookie'), null);
});

test('trusted proxy login throttling uses the final forwarded client address', async t => {
  const port = await freePort();
  const password = 'test-password-only';
  const proxy = await startProxy({
    port,
    host: '127.0.0.1',
    apiBase: 'http://127.0.0.1:1',
    usageAllowedIps: ['*'],
    adminAuth: {
      enabled: true,
      passwordHash: passwordHash(password),
      allowedIps: ['*'],
      trustedProxyIps: ['127.0.0.1'],
      sessionTtlMinutes: 30,
      secureCookie: true,
    },
    accountPool: { enabled: false },
  });
  t.after(() => proxy.close());

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`${proxy.baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '192.0.2.99, 198.51.100.10',
        'X-Forwarded-Proto': 'https',
      },
      body: JSON.stringify({ password: 'wrong-password' }),
    });
    assert.equal(response.status, 401);
  }

  const otherClientResponse = await fetch(`${proxy.baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '192.0.2.99, 198.51.100.11',
      'X-Forwarded-Proto': 'https',
    },
    body: JSON.stringify({ password }),
  });
  assert.equal(otherClientResponse.status, 200);

  const spoofedPrefixResponse = await fetch(`${proxy.baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '203.0.113.200, 198.51.100.10',
      'X-Forwarded-Proto': 'https',
    },
    body: JSON.stringify({ password }),
  });
  assert.equal(spoofedPrefixResponse.status, 429);
  assert.equal(spoofedPrefixResponse.headers.get('set-cookie'), null);
});

test('admin login rate limit cannot be bypassed with the correct password after five failures', async t => {
  const port = await freePort();
  const password = 'test-password-only';
  const proxy = await startProxy({
    port,
    host: '127.0.0.1',
    apiBase: 'http://127.0.0.1:1',
    usageAllowedIps: ['*'],
    adminAuth: {
      enabled: true,
      passwordHash: passwordHash(password),
      allowedIps: ['127.0.0.1'],
      trustedProxyIps: [],
      sessionTtlMinutes: 30,
      secureCookie: false,
    },
    accountPool: { enabled: false },
  });
  t.after(() => proxy.close());

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`${proxy.baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' }),
    });
    assert.equal(response.status, 401);
  }

  const blockedResponse = await fetch(`${proxy.baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  assert.equal(blockedResponse.status, 429);
  assert.equal(blockedResponse.headers.get('set-cookie'), null);
});
