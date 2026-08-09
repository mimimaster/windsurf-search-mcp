#!/usr/bin/env node
/**
 * windsurf-search — CLI + library for Windsurf/Devin server-side web search
 * (GetWebSearchResults). Zero runtime dependencies (Node >= 20 fetch).
 *
 * Usage:
 *   windsurf-search "some query" [--limit 5] [--domain example.com] [--mode 2]
 *   windsurf-search config set|show|test|clear
 *   windsurf-search --login
 *
 * API key resolution order:
 *   1. --api-key <key>
 *   2. WINDSURF_API_KEY / WINDSURFAPI_CODEIUM_API_KEY env
 *   3. key file candidates (first existing):
 *        ~/.config/windsurf-search/api-key
 *        ~/.windsurf-search/api-key
 *        ~/.piwin/windsurf-api-key   (compat)
 *
 * Exit codes: 0 = success, 1 = error, 2 = usage.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const WEB_SEARCH_PATH = '/exa.api_server_pb.ApiServerService/GetWebSearchResults';
const SERVER_HOSTS = ['server.codeium.com', 'server.self-serve.windsurf.com'];
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_LIMIT = 10;

// Windsurf/Devin 登录链路（邮箱密码路径，2026-05 后唯一可用路径）：
//   Auth1 password/login → WindsurfPostAuth → sessionToken
// sessionToken 直接作为 apiKey 使用（devin-session-token$xxx），与
// GetUserStatus / GetWebSearchResults 的 metadata.apiKey 认证兼容。
const AUTH1_PASSWORD_LOGIN_URL = 'https://windsurf.com/_devin-auth/password/login';
const POST_AUTH_URL_LEGACY =
  'https://server.self-serve.windsurf.com/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth';
const POST_AUTH_URL_NEW =
  'https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth';

// Injected fetch seam for tests.
let fetchImpl = fetch;
export function __setWindsurfSearchFetchForTest(fn) {
  fetchImpl = fn || fetch;
}

// ─── pure helpers (unit-testable) ──────────────────────────────────────

export function buildRequestBody(apiKey, query, { limit = 5, domain = '', mode, thirdPartyConfig = null } = {}) {
  const trimmed = String(query || '').trim();
  if (!trimmed) {
    throw new Error('windsurf-search: empty query');
  }
  const body = {
    metadata: {
      apiKey,
      ideName: 'windsurf',
      ideVersion: '1.9600.41',
      extensionName: 'windsurf',
      extensionVersion: '1.9600.41',
      locale: 'en',
    },
    query: trimmed,
    limit: Math.max(1, Math.min(MAX_LIMIT, Number(limit) || 5)),
  };
  if (domain) body.domain = String(domain);
  if (mode !== undefined && mode !== null && mode !== '') body.mode = mode;
  if (thirdPartyConfig && typeof thirdPartyConfig === 'object') {
    body.thirdPartyConfig = thirdPartyConfig;
  }
  return body;
}

function firstString(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

/** Normalize one raw upstream result into a piwin SearchHit shape. */
export function normalizeHit(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw;
  const title = firstString(record.title, record.name, record.webTitle);
  const url = firstString(record.url, record.sourceUrl, record.webUrl, record.link);
  if (!title || !url) return null;
  const snippet = firstString(record.snippet, record.summary, record.text, record.content);
  return { title, url, snippet, source: 'windsurf' };
}

export function normalizeHits(payload) {
  const rawResults = Array.isArray(payload?.results) ? payload.results : [];
  return rawResults.map(normalizeHit).filter(Boolean);
}

// ─── network call ──────────────────────────────────────────────────────

async function postJson(fetchFn, host, path, body, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(`https://${host}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        Accept: 'application/json',
        'User-Agent': 'windsurf/1.9600.41',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (response.status >= 400) {
      const raw = await response.text();
      throw new Error(`GetWebSearchResults ${host} -> HTTP ${response.status}: ${raw.slice(0, 200)}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run one search against Windsurf's direct web search endpoint.
 * Tries every SERVER_HOSTS in order until one returns 2xx.
 */
export async function searchWindsurf(apiKey, query, options = {}) {
  const body = buildRequestBody(apiKey, query, options);
  const fetchFn = options.fetchImpl || fetchImpl;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const hosts = options.hosts && options.hosts.length ? options.hosts : SERVER_HOSTS;
  let lastError = null;
  for (const host of hosts) {
    try {
      const payload = await postJson(fetchFn, host, WEB_SEARCH_PATH, body, { timeoutMs });
      return normalizeHits(payload);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('windsurf-search: all hosts failed');
}

// ─── key resolution ────────────────────────────────────────────────────

export function candidateKeyFilePaths() {
  const home = homedir();
  return [
    join(home, '.config', 'windsurf-search', 'api-key'),
    join(home, '.windsurf-search', 'api-key'),
    join(home, '.piwin', 'windsurf-api-key'), // compat with earlier local installs
  ];
}

export function defaultKeyFilePath() {
  return candidateKeyFilePaths()[0];
}

export async function resolveApiKey({ cliValue = '', env = process.env, keyFile } = {}) {
  if (cliValue && cliValue.trim()) return cliValue.trim();
  const fromEnv = env.WINDSURF_API_KEY || env.WINDSURFAPI_CODEIUM_API_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  const paths = keyFile ? [keyFile] : candidateKeyFilePaths();
  for (const filePath of paths) {
    try {
      const content = await readFile(filePath, 'utf8');
      const line = content.split('\n')[0];
      if (line && line.trim()) return line.trim();
    } catch {
      // try next candidate
    }
  }

  throw new Error(
    'windsurf-search: no API key. Set WINDSURF_API_KEY, pass --api-key, or write the key to ~/.config/windsurf-search/api-key',
  );
}

// ─── login (email/password → apiKey) ───────────────────────────────────

/** 浏览器式指纹头，Auth1/PostAuth 端点要求。 */
function buildBrowserFingerprintHeaders() {
  const ua =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
  return {
    'User-Agent': ua,
    'Accept-Language': 'en-US,en;q=0.9',
    Accept: 'application/json, text/plain, */*',
    'Accept-Encoding': 'identity',
    'sec-ch-ua': '"Chromium";v="125", "Google Chrome";v="125", "Not.A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
    Origin: 'https://windsurf.com',
    Referer: 'https://windsurf.com/',
  };
}

/**
 * Windsurf/Devin 邮箱密码登录 → sessionToken（作为 apiKey）。
 *
 * 2026-05 后 Firebase/RegisterUser 路径已废弃，唯一可用链路是：
 *   1. Auth1 password/login → auth1Token
 *   2. WindsurfPostAuth（X-Devin-Auth1-Token 头，空 application/proto body）→ sessionToken
 * sessionToken 形如 `devin-session-token$xxx`，直接作为 metadata.apiKey 使用。
 */
export async function loginWindsurf(email, password, { fetchImpl: fn = fetchImpl } = {}) {
  const fingerprint = buildBrowserFingerprintHeaders();

  // Step 1: Auth1 password/login
  const loginBody = JSON.stringify({ email, password });
  const loginResponse = await fn(AUTH1_PASSWORD_LOGIN_URL, {
    method: 'POST',
    headers: { ...fingerprint, 'Content-Type': 'application/json', 'Content-Length': loginBody.length },
    body: loginBody,
  });
  const loginPayload = await loginResponse.json().catch(() => ({}));
  const loginDetail = loginPayload?.detail;
  const detailMsg = Array.isArray(loginDetail)
    ? loginDetail.map((d) => d?.msg || d?.type || JSON.stringify(d)).join('; ')
    : typeof loginDetail === 'string' ? loginDetail : '';
  if (loginResponse.status >= 400 || detailMsg) {
    throw new Error(`windsurf-search login: ${detailMsg || `Auth1 login failed with HTTP ${loginResponse.status}`}`);
  }
  const auth1Token = loginPayload?.token;
  if (!auth1Token) {
    throw new Error(`windsurf-search login: Auth1 token missing: ${JSON.stringify(loginPayload).slice(0, 200)}`);
  }

  // Step 2: WindsurfPostAuth → sessionToken（双 host 重试，新路径优先）
  const postAuthUrls = [POST_AUTH_URL_NEW, POST_AUTH_URL_LEGACY];
  let lastError = null;
  for (const url of postAuthUrls) {
    try {
      const paResponse = await fn(url, {
        method: 'POST',
        headers: {
          ...fingerprint,
          'Content-Type': 'application/proto',
          'Content-Length': 0,
          'Connect-Protocol-Version': '1',
          'X-Devin-Auth1-Token': auth1Token,
          Referer: 'https://windsurf.com/account/login',
        },
        body: '',
      });
      const paText = await paResponse.text().catch(() => '');
      const sessionToken = extractSessionToken(paText);
      if (paResponse.status >= 200 && paResponse.status < 300 && sessionToken) {
        return { apiKey: sessionToken, name: email, email, sessionToken };
      }
      lastError = new Error(`PostAuth ${new URL(url).host} HTTP ${paResponse.status}: ${paText.slice(0, 160)}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('windsurf-search login: PostAuth failed on all hosts');
}

/** PostAuth 返回可能是 JSON 或裸 proto 文本，两种都提取 sessionToken。 */
export function extractSessionToken(payload) {
  const raw = String(payload || '');
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.sessionToken) return parsed.sessionToken;
  } catch {
    // not JSON — fall through to regex
  }
  return raw.match(/devin-session-token\$[a-zA-Z0-9._-]+/)?.[0] || '';
}

// ─── config subcommand (set / show / test / clear) ─────────────────────

/** 掩码 key 用于安全展示（只露前后缀，避免在聊天/日志里泄露完整 token）。 */
export function maskKey(key) {
  const text = String(key || '');
  if (!text) return '(empty)';
  if (text.length <= 12) return `${text.slice(0, 2)}…${text.slice(-2)}`;
  return `${text.slice(0, 12)}…${text.slice(-6)}`;
}

/** 根据 key 前缀判断格式，辅助 config show / config test 输出提示。 */
export function describeKeyFormat(key) {
  const text = String(key || '').trim();
  if (!text) return { kind: 'missing', label: 'no key', ok: false };
  if (text.startsWith('devin-session-token$')) {
    return { kind: 'session-token', label: 'devin-session-token (session token)', ok: true };
  }
  if (text.startsWith('sk-ws-')) {
    return { kind: 'legacy-api-key', label: 'sk-ws-* (legacy API key)', ok: true };
  }
  if (text.startsWith('ott$')) {
    return { kind: 'one-time-token', label: 'ott$* (one-time token, deprecated)', ok: false };
  }
  return { kind: 'unknown', label: 'unknown key format', ok: false };
}

/** 读取 key 文件第一行（不含换行）；文件不存在时返回空串。 */
export async function readConfiguredKey({ keyFile } = {}) {
  try {
    const content = await readFile(keyFile || defaultKeyFilePath(), 'utf8');
    return content.split('\n')[0]?.trim() || '';
  } catch {
    return '';
  }
}

/** 把 key 写入 key 文件（自动建目录，chmod 600）。 */
export async function saveKey(keyPath, key) {
  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir(dirname(keyPath), { recursive: true });
  await writeFile(keyPath, `${key.trim()}\n`, { mode: 0o600 });
}

async function runConfigCommand(action, args, { keyFile = defaultKeyFilePath() } = {}) {
  if (action === 'set') {
    let key = args[0] || '';
    if (!key) key = await promptLine('Windsurf API key: ', { password: true });
    if (!key || !key.trim()) {
      process.stderr.write('windsurf-search config set: key is required\n');
      return 2;
    }
    await saveKey(keyFile, key);
    const format = describeKeyFormat(key);
    process.stdout.write(
      `saved key to ${keyFile}\n` +
        `format: ${format.label}\n` +
        (format.ok ? '' : 'warning: this key format may not work with GetWebSearchResults\n'),
    );
    return 0;
  }

  if (action === 'show') {
    const key = await readConfiguredKey({ keyFile });
    const format = describeKeyFormat(key);
    process.stdout.write(
      `config file: ${keyFile}\n` +
        `key: ${key ? maskKey(key) : '(not configured)'}\n` +
        `format: ${format.label}\n` +
        `status: ${key ? 'configured' : 'missing'}\n`,
    );
    return key ? 0 : 2;
  }

  if (action === 'test') {
    const query = args[0] || 'windsurf search connectivity test';
    let key;
    try {
      key = await resolveApiKey({ keyFile });
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    process.stdout.write(
      `testing key ${maskKey(key)} (${describeKeyFormat(key).label}) with query "${query}"\n`,
    );
    try {
      const hits = await searchWindsurf(key, query, { limit: 1 });
      process.stdout.write(`OK: got ${hits.length} result(s)\n`);
      if (hits.length > 0) {
        process.stdout.write(`  [1] ${hits[0]?.title}\n      ${hits[0]?.url}\n`);
      }
      return 0;
    } catch (error) {
      process.stderr.write(`FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  if (action === 'clear') {
    const { rm } = await import('node:fs/promises');
    try {
      await rm(keyFile, { force: true });
      process.stdout.write(`removed ${keyFile}\n`);
      return 0;
    } catch (error) {
      process.stderr.write(`windsurf-search config clear: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  process.stderr.write('windsurf-search config: unknown action. use set | show | test | clear\n');
  return 2;
}

// ─── CLI ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) continue;
    if (token === '--limit' || token === '--domain' || token === '--mode' || token === '--api-key') {
      flags[token.slice(2)] = argv[index + 1];
      index += 1;
    } else if (token.startsWith('--')) {
      flags[token.slice(2)] = true;
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

function printUsage(stream) {
  stream.write(
    'windsurf-search: Windsurf/Devin web search CLI (+ MCP companion)\n' +
      'usage:\n' +
      '  windsurf-search <query> [--limit N] [--domain d] [--mode m] [--api-key k]\n' +
      '  windsurf-search --login                (prompts for email+password, saves key to ~/.config/windsurf-search/api-key)\n' +
      '  windsurf-search --login <email> <password>\n' +
      '  windsurf-search config set <key>       (save a key to ~/.config/windsurf-search/api-key, chmod 600)\n' +
      '  windsurf-search config show            (show saved key status, masked)\n' +
      '  windsurf-search config test [query]    (run a real search to verify the configured key)\n' +
      '  windsurf-search config clear           (remove the saved key file)\n',
  );
}

/**
 * 交互式读取一行输入。password=true 时隐藏回显（输出到 stderr，不污染 stdout JSON）。
 */
async function promptLine(promptText, { password = false } = {}) {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: process.stdin.isTTY,
  });
  try {
    return await new Promise((resolve) => {
      if (password && rl.terminal) {
        // 隐藏密码回显：自己渲染提示符，静默读行
        let input = '';
        const rawOnData = (chunk) => {
          const str = chunk.toString('utf8');
          for (const ch of str) {
            if (ch === '\n' || ch === '\r') {
              process.stderr.write('\n');
              resolve(input);
              cleanup();
              return;
            }
            if (ch === '\u0003') {
              // Ctrl-C
              process.stderr.write('^C\n');
              resolve('');
              cleanup();
              return;
            }
            if (ch === '\u007f' || ch === '\b') {
              input = input.slice(0, -1);
              process.stderr.write('\b \b');
            } else {
              input += ch;
              process.stderr.write('*');
            }
          }
        };
        const cleanup = () => {
          process.stdin.off('data', rawOnData);
          rl.close();
        };
        process.stderr.write(promptText);
        process.stdin.setRawMode?.(true);
        process.stdin.on('data', rawOnData);
      } else {
        rl.question(promptText, (answer) => {
          rl.close();
          resolve(answer.trim());
        });
      }
    });
  } finally {
    process.stdin.setRawMode?.(false);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { positionals, flags } = parseArgs(argv);

  if (flags.login) {
    let email = positionals[0] || '';
    let password = positionals[1] || '';
    if (!email) email = await promptLine('Windsurf email: ');
    if (!password) password = await promptLine('Windsurf password: ', { password: true });
    if (!email || !password) {
      process.stderr.write('windsurf-search login: email and password are required\n');
      return 2;
    }
    try {
      const result = await loginWindsurf(email, password);
      const keyPath = defaultKeyFilePath();
      const { writeFile, mkdir } = await import('node:fs/promises');
      await mkdir(dirname(keyPath), { recursive: true });
      await writeFile(keyPath, `${result.apiKey}\n`, { mode: 0o600 });
      process.stderr.write(
        `windsurf-search login: OK for ${result.email} — apiKey saved to ${keyPath} (chmod 600)\n`,
      );
      return 0;
    } catch (error) {
      process.stderr.write(`windsurf-search login: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  if (positionals[0] === 'config') {
    return runConfigCommand(positionals[1] || '', positionals.slice(2));
  }

  if (positionals.length === 0) {
    printUsage(process.stderr);
    return 2;
  }
  const query = positionals.join(' ');
  let apiKey;
  try {
    apiKey = await resolveApiKey({ cliValue: flags['api-key'] });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const limit = Number(flags.limit) > 0 ? Number(flags.limit) : 5;
  const options = { limit };
  if (flags.domain) options.domain = String(flags.domain);
  if (flags.mode) options.mode = Number(flags.mode) || String(flags.mode);
  try {
    const hits = await searchWindsurf(apiKey, query, options);
    process.stdout.write(`${JSON.stringify({ hits })}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`windsurf-search: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

// Run when executed directly (not when imported by tests).
function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    const invoked = realpathSync(process.argv[1]);
    const current = realpathSync(new URL(import.meta.url));
    return pathToFileURL(invoked).href === pathToFileURL(current).href;
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}
if (isDirectExecution()) {
  process.exitCode = await main();
}
