import assert from 'node:assert/strict';
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

async function startProxy(config) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'commandcode-protocol-test-'));
  copyFileSync(path.join(projectRoot, 'proxy.mjs'), path.join(directory, 'proxy.mjs'));
  writeFileSync(path.join(directory, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  let output = '';
  const child = spawn(process.execPath, ['proxy.mjs'], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const baseUrl = `http://127.0.0.1:${config.port}`;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`proxy exited early (${child.exitCode})\n${output}`);
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
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

async function runChat(baseUrl) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer user_protocol_alignment_test_key',
      'Content-Type': 'application/json',
      'x-session-id': 'c30b5aa2-12c3-4ef0-a719-38ea7015bcdf',
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      stream: false,
      messages: [{ role: 'user', content: 'protocol probe' }],
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
}

test('deterministic fingerprint survives restart and all CC calls share the configured CONNECT proxy', async t => {
  const fingerprints = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url === '/alpha/fingerprint/record') {
      fingerprints.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(204).end();
      return;
    }
    if (req.url === '/alpha/lifecycle-events') {
      res.writeHead(204).end();
      return;
    }
    if (req.url === '/alpha/generate') {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.end(`${JSON.stringify({ type: 'text-delta', text: 'ok' })}\n${JSON.stringify({ type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 5, outputTokens: 1, cachedInputTokens: 0 } })}\n`);
      return;
    }
    res.writeHead(404).end();
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  const connectRequests = [];
  const connectProxy = http.createServer();
  connectProxy.on('connect', (req, clientSocket, head) => {
    connectRequests.push({ target: req.url, authorization: req.headers['proxy-authorization'] });
    const separator = req.url.lastIndexOf(':');
    const host = req.url.slice(0, separator);
    const port = Number(req.url.slice(separator + 1));
    const upstreamSocket = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
    upstreamSocket.on('error', () => clientSocket.destroy());
  });
  const connectProxyPort = await listen(connectProxy);
  t.after(() => new Promise(resolve => connectProxy.close(resolve)));

  const common = {
    host: '127.0.0.1',
    apiBase: `http://127.0.0.1:${upstreamPort}`,
    upstreamProxy: `http://probe-user:probe-pass@127.0.0.1:${connectProxyPort}`,
    useProviderModels: false,
    usageAllowedIps: ['*'],
    adminAuth: { enabled: false },
    accountPool: { enabled: false },
  };

  const first = await startProxy({ ...common, port: await freePort() });
  await runChat(first.baseUrl);
  assert.doesNotMatch(first.output(), /probe-user|probe-pass/);
  await first.close();

  const second = await startProxy({ ...common, port: await freePort() });
  t.after(() => second.close());
  await runChat(second.baseUrl);
  assert.doesNotMatch(second.output(), /probe-user|probe-pass/);

  assert.equal(fingerprints.length, 2);
  assert.deepEqual(fingerprints[1], fingerprints[0], 'same key must keep the same device identity across restarts');
  assert.equal(connectRequests.length, 6, 'fingerprint, lifecycle, and generate must all use the proxy on both runs');
  assert.ok(connectRequests.every(request => request.target === `127.0.0.1:${upstreamPort}`));
  assert.ok(connectRequests.every(request => request.authorization?.startsWith('Basic ')));
});
