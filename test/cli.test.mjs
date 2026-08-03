import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildRequestBody,
  normalizeHit,
  normalizeHits,
  searchWindsurf,
  resolveApiKey,
  loginWindsurf,
  extractSessionToken,
  maskKey,
  describeKeyFormat,
  readConfiguredKey,
  saveKey,
  __setWindsurfSearchFetchForTest,
} from '../bin/windsurf-search.mjs';

test('buildRequestBody trims query and clamps limit to 1..10', () => {
  const body = buildRequestBody('key-1', '  hello world  ', { limit: 99 });
  assert.equal(body.query, 'hello world');
  assert.equal(body.limit, 10);
  assert.equal(body.metadata.apiKey, 'key-1');
  assert.equal(body.metadata.ideName, 'windsurf');
});

test('buildRequestBody rejects empty query', () => {
  assert.throws(() => buildRequestBody('key', '   '), /empty query/);
});

test('buildRequestBody includes domain, mode, and thirdPartyConfig only when set', () => {
  const body = buildRequestBody('key', 'q', {
    domain: 'github.com',
    mode: 2,
    thirdPartyConfig: { provider: 1, model: 3 },
  });
  assert.equal(body.domain, 'github.com');
  assert.equal(body.mode, 2);
  assert.deepEqual(body.thirdPartyConfig, { provider: 1, model: 3 });
});

test('normalizeHit maps upstream fields to piwin SearchHit', () => {
  const hit = normalizeHit({
    title: 'Example',
    url: 'https://example.com',
    snippet: 'A snippet',
    summary: 'ignored',
  });
  assert.deepEqual(hit, {
    title: 'Example',
    url: 'https://example.com',
    snippet: 'A snippet',
    source: 'windsurf',
  });
});

test('normalizeHit accepts sourceUrl/webUrl and falls back across fields', () => {
  const hit = normalizeHit({ name: 'N', sourceUrl: 'https://a.com', text: 'T' });
  assert.deepEqual(hit, { title: 'N', url: 'https://a.com', snippet: 'T', source: 'windsurf' });
});

test('normalizeHit returns null for items missing title or url', () => {
  assert.equal(normalizeHit(null), null);
  assert.equal(normalizeHit({ title: 'no url' }), null);
  assert.equal(normalizeHit({ url: 'https://x.com' }), null);
});

test('normalizeHits filters invalid results and survives non-array payload', () => {
  const hits = normalizeHits({
    results: [
      { title: 'ok', url: 'https://ok.com', snippet: 's' },
      { title: 'bad' },
      null,
    ],
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.title, 'ok');
  assert.deepEqual(normalizeHits({}), []);
});

test('searchWindsurf posts correct request and returns hits', async () => {
  const calls = [];
  __setWindsurfSearchFetchForTest(async (url, init) => {
    calls.push({ url, init });
    return {
      status: 200,
      json: async () => ({
        results: [{ title: 'R', url: 'https://r.com', snippet: 'rs' }],
        webSearchUrl: 'https://search/?q=test',
        summary: 'sum',
      }),
    };
  });

  const hits = await searchWindsurf('key', 'test query', { limit: 3 });
  assert.equal(hits.length, 1);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.match(call.url, /server\.codeium\.com\/exa\.api_server_pb\.ApiServerService\/GetWebSearchResults/);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['Connect-Protocol-Version'], '1');
  const body = JSON.parse(call.init.body);
  assert.equal(body.metadata.apiKey, 'key');
  assert.equal(body.query, 'test query');
  assert.equal(body.limit, 3);
});

test('searchWindsurf falls back to the next host on HTTP 500', async () => {
  const calls = [];
  __setWindsurfSearchFetchForTest(async (url) => {
    calls.push(url);
    if (calls.length === 1) {
      return { status: 500, text: async () => 'boom' };
    }
    return { status: 200, json: async () => ({ results: [] }) };
  });

  const hits = await searchWindsurf('key', 'q', { hosts: ['a.com', 'b.com'] });
  assert.deepEqual(hits, []);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /b\.com/);
});

test('searchWindsurf throws after all hosts fail', async () => {
  __setWindsurfSearchFetchForTest(async () => {
    return { status: 500, text: async () => 'nope' };
  });
  await assert.rejects(
    () => searchWindsurf('key', 'q', { hosts: ['a.com', 'b.com'] }),
    /all hosts failed|HTTP 500/,
  );
});

test('resolveApiKey prefers --api-key over env over key file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'windsurf-search-test-'));
  const keyFile = join(dir, 'key');
  await writeFile(keyFile, 'file-key\n');

  assert.equal(await resolveApiKey({ cliValue: 'cli-key' }), 'cli-key');
  assert.equal(
    await resolveApiKey({ cliValue: '', env: { WINDSURF_API_KEY: 'env-key' }, keyFile }),
    'env-key',
  );
  assert.equal(await resolveApiKey({ cliValue: '', env: {}, keyFile }), 'file-key');

  await rm(dir, { recursive: true, force: true });
});

test('resolveApiKey throws a helpful message when no key is available', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'windsurf-search-test-'));
  await assert.rejects(
    () => resolveApiKey({ cliValue: '', env: {}, keyFile: join(dir, 'missing') }),
    /no API key/,
  );
  await rm(dir, { recursive: true, force: true });
});

test('resolveApiKey reads WINDSURF_API_KEY from the process environment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'windsurf-search-test-'));
  const keyFile = join(dir, 'key');
  await writeFile(keyFile, 'file-key\n');
  assert.equal(
    await resolveApiKey({ cliValue: '', env: { WINDSURF_API_KEY: 'env-windsurf-key' }, keyFile }),
    'env-windsurf-key',
  );
  assert.equal(
    await resolveApiKey({
      cliValue: '',
      env: { WINDSURFAPI_CODEIUM_API_KEY: 'legacy-key' },
      keyFile,
    }),
    'legacy-key',
  );
  await rm(dir, { recursive: true, force: true });
});

test('extractSessionToken parses JSON responses', () => {
  assert.equal(
    extractSessionToken('{"sessionToken":"devin-session-token$abc.def","accountId":"account-x"}'),
    'devin-session-token$abc.def',
  );
});

test('extractSessionToken parses raw proto text responses', () => {
  const raw = '\x00\x01\x02sessionTokendevin-session-token$xyz789-abc_def.jkl\x00\x03';
  assert.equal(extractSessionToken(raw), 'devin-session-token$xyz789-abc_def.jkl');
});

test('extractSessionToken returns empty for unknown payloads', () => {
  assert.equal(extractSessionToken(''), '');
  assert.equal(extractSessionToken('{"error":"boom"}'), '');
});

test('loginWindsurf exchanges password for sessionToken via Auth1 + PostAuth', async () => {
  const calls = [];
  __setWindsurfSearchFetchForTest(async (url, init) => {
    calls.push({ url, init });
    if (url.includes('_devin-auth/password/login')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: 'auth1-token-123' }),
      };
    }
    if (url.includes('WindsurfPostAuth')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ sessionToken: 'devin-session-token$real-abc' }),
      };
    }
    throw new Error(`unexpected url ${url}`);
  });

  const result = await loginWindsurf('a@b.com', 'secret');
  assert.equal(result.apiKey, 'devin-session-token$real-abc');
  assert.equal(result.sessionToken, 'devin-session-token$real-abc');
  assert.equal(result.email, 'a@b.com');

  // Auth1 请求带浏览器指纹头
  const auth1Call = calls[0];
  assert.equal(auth1Call.init.method, 'POST');
  assert.match(auth1Call.init.headers['User-Agent'], /Chrome/);
  assert.equal(auth1Call.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(auth1Call.init.body), { email: 'a@b.com', password: 'secret' });

  // PostAuth 请求带 X-Devin-Auth1-Token 头和 application/proto
  const paCall = calls[1];
  assert.equal(paCall.init.headers['X-Devin-Auth1-Token'], 'auth1-token-123');
  assert.equal(paCall.init.headers['Content-Type'], 'application/proto');
});

test('loginWindsurf falls back to legacy PostAuth host', async () => {
  const calls = [];
  __setWindsurfSearchFetchForTest(async (url, init) => {
    calls.push(url);
    if (url.includes('_devin-auth/password/login')) {
      return { ok: true, status: 200, json: async () => ({ token: 'auth1-token-2' }) };
    }
    if (url.includes('windsurf.com/_backend') && url.includes('WindsurfPostAuth')) {
      return { ok: false, status: 500, text: async () => 'boom' };
    }
    if (url.includes('server.self-serve.windsurf.com') && url.includes('WindsurfPostAuth')) {
      return { ok: true, status: 200, text: async () => 'devin-session-token$legacy-host-9' };
    }
    throw new Error(`unexpected url ${url}`);
  });

  const result = await loginWindsurf('a@b.com', 'secret');
  assert.equal(result.apiKey, 'devin-session-token$legacy-host-9');
  assert.equal(calls.length, 3);
});

test('loginWindsurf surfaces auth1 errors', async () => {
  __setWindsurfSearchFetchForTest(async (url) => {
    if (url.includes('_devin-auth/password/login')) {
      return {
        ok: false,
        status: 401,
        json: async () => ({ detail: 'Invalid credentials' }),
      };
    }
    throw new Error(`unexpected url ${url}`);
  });
  await assert.rejects(
    () => loginWindsurf('a@b.com', 'wrong'),
    /Invalid credentials/,
  );
});

test('maskKey hides the middle of a session token', () => {
  const masked = maskKey('devin-session-token$eyJhbGciOiJIUzI1NiJ9.signature');
  assert.notEqual(masked, 'devin-session-token$eyJhbGciOiJIUzI1NiJ9.signature');
  assert.ok(masked.includes('devin-sessio'));
  assert.ok(masked.includes('nature'));
  assert.ok(masked.includes('…'));
});

test('maskKey handles short keys and empty input', () => {
  assert.equal(maskKey(''), '(empty)');
  assert.equal(maskKey('abc'), 'ab…bc');
});

test('describeKeyFormat classifies known token prefixes', () => {
  assert.equal(describeKeyFormat('devin-session-token$abc').kind, 'session-token');
  assert.equal(describeKeyFormat('sk-ws-123').kind, 'legacy-api-key');
  assert.equal(describeKeyFormat('ott$xyz').kind, 'one-time-token');
  assert.equal(describeKeyFormat('something-weird').kind, 'unknown');
  assert.equal(describeKeyFormat('').kind, 'missing');
  assert.equal(describeKeyFormat('  ').kind, 'missing');
});

test('readConfiguredKey reads the first non-empty line from the key file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'windsurf-search-config-'));
  const keyFile = join(dir, 'key');
  await writeFile(keyFile, 'devin-session-token$abc\nsecond-line\n');

  assert.equal(await readConfiguredKey({ keyFile }), 'devin-session-token$abc');
  assert.equal(await readConfiguredKey({ keyFile: join(dir, 'missing') }), '');
  await rm(dir, { recursive: true, force: true });
});

test('saveKey writes the trimmed key with a trailing newline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'windsurf-search-savekey-'));
  const keyFile = join(dir, 'nested', 'key');
  await saveKey(keyFile, '  devin-session-token$def  ');

  const { readFile } = await import('node:fs/promises');
  const content = await readFile(keyFile, 'utf8');
  assert.equal(content, 'devin-session-token$def\n');
  await rm(dir, { recursive: true, force: true });
});

test('saveKey and readConfiguredKey round-trip through config set semantics', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'windsurf-search-roundtrip-'));
  const keyFile = join(dir, 'key');
  await saveKey(keyFile, 'devin-session-token$round-trip');
  assert.equal(await readConfiguredKey({ keyFile }), 'devin-session-token$round-trip');
  await rm(dir, { recursive: true, force: true });
});
