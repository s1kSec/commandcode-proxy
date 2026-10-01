import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = name => ({ name, input_schema: { type: 'object', properties: { text: { type: 'string' } } } });

// Model the upstream behavior seen in the Runner: a message between a tool
// call and its results finishes with zero output rather than a useful reply.
function toolResultsAreAdjacent(messages) {
  const pending = new Set();
  for (const message of messages) {
    if (message.role === 'tool') {
      for (const part of message.content) {
        if (part.type !== 'tool-result' || !pending.delete(part.toolCallId)) return false;
      }
      continue;
    }
    if (pending.size) return false;
    if (message.role === 'assistant') {
      for (const part of message.content) {
        if (part.type === 'tool-call') pending.add(part.toolCallId);
      }
    }
  }
  return pending.size === 0;
}

for (const stream of [false, true]) {
  for (const multiple of [false, true]) {
    test(`/v1/messages: ${stream ? 'stream' : 'non-stream'} mixed text and ${multiple ? 'multiple tool results' : 'tool result'} continue successfully`, async t => {
      let forwarded;
      const fixture = await startFixture(t, body => {
        forwarded = body;
        return toolResultsAreAdjacent(body.params.messages)
          ? [{ type: 'text-delta', text: 'continued' }, { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 20, outputTokens: 2 } }]
          : [{ type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 20, outputTokens: 0 } }];
      });
      const ids = multiple ? ['call_first', 'call_second'] : ['call_first'];
      const results = ids.map((id, index) => ({
        type: 'tool_result', tool_use_id: id,
        content: index ? [{ type: 'text', text: 'second ' }, { type: 'text', text: 'result' }] : 'first result',
      }));
      const mixed = [{ type: 'text', text: 'Skill is loaded. ' }, results[0], { type: 'text', text: 'Continue.' }];
      if (multiple) mixed.push(results[1]);
      const response = await fixture.send({
        stream, model: 'gpt-5.6-luna[1M]', tools: ids.map((_, index) => tool(`Echo${index + 1}`)),
        messages: [
          { role: 'user', content: 'Load the requested skill.' },
          { role: 'assistant', content: ids.map((id, index) => ({ type: 'tool_use', id, name: `Echo${index + 1}`, input: { text: 'probe' } })) },
          { role: 'user', content: mixed },
        ],
      });
      const body = await response.text();
      assert.equal(response.status, 200, body);
      assert.match(body, /continued/);
      assert.equal(forwarded.params.model, 'gpt-5.6-luna');
      assert.deepEqual(forwarded.params.messages.map(message => message.role), ['user', 'assistant', ...ids.map(() => 'tool'), 'user']);
      const forwardedResults = forwarded.params.messages.filter(message => message.role === 'tool').map(message => message.content[0]);
      assert.deepEqual(forwardedResults.map(part => part.toolCallId), ids);
      assert.deepEqual(forwardedResults.map(part => part.toolName), ids.map((_, index) => `Echo${index + 1}`));
      assert.deepEqual(forwardedResults.map(part => part.output.value), multiple ? ['first result', 'second result'] : ['first result']);
      assert.equal(forwarded.params.messages.at(-1).content[0].text, 'Skill is loaded. Continue.');
    });
  }
}

for (const finishReason of ['tool-calls', 'tool_calls']) {
  test(`/v1/messages: streaming ${finishReason} ends with tool_use`, async t => {
    const fixture = await startFixture(t, () => [
      { type: 'tool-call', toolCallId: 'call_echo', toolName: 'Echo', input: { text: 'probe' } },
      { type: 'finish', finishReason, totalUsage: { inputTokens: 10, outputTokens: 5 } },
    ]);
    const response = await fixture.send({ stream: true, tools: [tool('Echo')], messages: [{ role: 'user', content: 'Use Echo.' }] });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    const events = body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    assert.equal(events.find(event => event.type === 'content_block_start')?.content_block.type, 'tool_use');
    assert.equal(events.find(event => event.type === 'message_delta')?.delta.stop_reason, 'tool_use');
  });
}

test('/v1/messages: ordinary user text still reaches upstream as one user message', async t => {
  let forwarded;
  const fixture = await startFixture(t, body => {
    forwarded = body;
    return [{ type: 'text-delta', text: 'ok' }, { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 5, outputTokens: 1 } }];
  });
  const response = await fixture.send({ messages: [{ role: 'user', content: [{ type: 'text', text: 'plain ' }, { type: 'text', text: 'text' }] }] });
  assert.equal(response.status, 200, await response.text());
  assert.deepEqual(forwarded.params.messages, [{ role: 'user', content: [{ type: 'text', text: 'plain text' }] }]);
});

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}

async function startFixture(t, generate) {
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url === '/alpha/fingerprint/record' || req.url === '/alpha/lifecycle-events') return res.writeHead(204).end();
    if (req.url !== '/alpha/generate') return res.writeHead(404).end();
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.end(generate(body).map(event => JSON.stringify(event)).join('\n') + '\n');
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const socket = http.createServer();
  const port = await listen(socket);
  await new Promise(resolve => socket.close(resolve));
  const temporaryRoot = path.resolve(os.tmpdir());
  const directory = mkdtempSync(path.join(temporaryRoot, 'commandcode-anthropic-test-'));
  copyFileSync(path.join(projectRoot, 'proxy.mjs'), path.join(directory, 'proxy.mjs'));
  writeFileSync(path.join(directory, 'config.json'), JSON.stringify({
    port, host: '127.0.0.1', apiBase: `http://127.0.0.1:${upstreamPort}`, useProviderModels: false, adminAuth: { enabled: false },
  }), { mode: 0o600 });
  const child = spawn(process.execPath, ['proxy.mjs'], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
    assert.equal(path.dirname(path.resolve(directory)), temporaryRoot);
    assert.ok(path.basename(directory).startsWith('commandcode-anthropic-test-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`proxy exited early (${child.exitCode})\n${output}`);
    try { if ((await fetch(`${baseUrl}/health`)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, `proxy did not become ready\n${output}`);
  return {
    send: body => fetch(`${baseUrl}/v1/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': 'user_anthropic_fixture_key' },
      body: JSON.stringify({ model: 'gpt-5.6-luna', max_tokens: 64, ...body }),
    }),
  };
}
