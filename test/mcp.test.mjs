import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const serverPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'windsurf-search-mcp.mjs');

/** 用 NDJSON（换行分隔）协议起一个 MCP server 子进程。 */
function spawnNdjsonServer() {
  const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let nextId = 1;
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof message?.id === 'number' && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message ?? 'MCP error'));
        else resolve(message.result);
      }
    }
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  async function close() {
    child.stdin.end();
    child.kill('SIGTERM');
    await new Promise((resolve) => child.on('close', resolve));
  }
  return { child, send, close };
}

/** 用 Content-Length 帧协议起一个 MCP server 子进程。 */
function spawnContentLengthServer() {
  const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let nextId = 1;
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = buffer.slice(0, headerEnd);
      const match = /^Content-Length:\s*(\d+)$/im.exec(header);
      if (!match) return;
      const bodyLength = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + bodyLength) return;
      const body = buffer.slice(bodyStart, bodyStart + bodyLength);
      buffer = buffer.slice(bodyStart + bodyLength);
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        continue;
      }
      if (typeof message?.id === 'number' && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message ?? 'MCP error'));
        else resolve(message.result);
      }
    }
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve, reject });
      const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    });
  }
  async function close() {
    child.stdin.end();
    child.kill('SIGTERM');
    await new Promise((resolve) => child.on('close', resolve));
  }
  return { child, send, close };
}

test('NDJSON: initialize returns MCP protocol handshake', async () => {
  const server = spawnNdjsonServer();
  try {
    const result = await server.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'windsurf-search-mcp-test', version: '0.0.0' },
    });
    assert.equal(result.protocolVersion, '2024-11-05');
    assert.equal(result.serverInfo.name, 'windsurf-search-mcp');
    assert.deepEqual(result.capabilities, { tools: {} });
  } finally {
    await server.close();
  }
});

test('NDJSON: tools/list exposes web_search with query required', async () => {
  const server = spawnNdjsonServer();
  try {
    const result = await server.send('tools/list');
    assert.equal(result.tools.length, 1);
    const tool = result.tools[0];
    assert.equal(tool.name, 'web_search');
    assert.ok(tool.description.includes('Devin/Windsurf'));
    assert.equal(tool.inputSchema.required[0], 'query');
    assert.equal(tool.inputSchema.properties.limit.maximum, 10);
  } finally {
    await server.close();
  }
});

test('NDJSON: tools/call with empty query returns isError', async () => {
  const server = spawnNdjsonServer();
  try {
    const result = await server.send('tools/call', { name: 'web_search', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /query is required/);
  } finally {
    await server.close();
  }
});

test('NDJSON: tools/call with unknown tool returns isError', async () => {
  const server = spawnNdjsonServer();
  try {
    const result = await server.send('tools/call', { name: 'nope', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /unknown tool/);
  } finally {
    await server.close();
  }
});

test('NDJSON: tools/call web_search performs a real search', { skip: !process.env.WINDSURF_API_KEY && !process.env.RUN_LIVE_SEARCH }, async () => {
  const server = spawnNdjsonServer();
  try {
    const result = await server.send('tools/call', {
      name: 'web_search',
      arguments: { query: 'tauri window drag region', limit: 2 },
    });
    assert.equal(result.isError, undefined);
    const { hits } = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(hits));
    assert.ok(hits.length >= 1);
    assert.ok(hits[0].title.length > 0);
    assert.ok(hits[0].url.startsWith('http'));
    assert.equal(hits[0].source, 'windsurf');
  } finally {
    await server.close();
  }
});

test('Content-Length: initialize + tools/list handshake works', async () => {
  const server = spawnContentLengthServer();
  try {
    const init = await server.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'windsurf-search-mcp-test', version: '0.0.0' },
    });
    assert.equal(init.serverInfo.name, 'windsurf-search-mcp');

    const tools = await server.send('tools/list');
    assert.equal(tools.tools[0].name, 'web_search');

    const call = await server.send('tools/call', { name: 'web_search', arguments: {} });
    assert.equal(call.isError, true);
  } finally {
    await server.close();
  }
});
