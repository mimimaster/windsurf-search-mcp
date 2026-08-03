#!/usr/bin/env node
/**
 * windsurf-search-mcp — MCP stdio server exposing Windsurf/Devin server-side
 * web search (GetWebSearchResults) as a `web_search` tool.
 *
 * Zero npm dependencies. Speaks both MCP JSON-RPC framings:
 *   - Content-Length framing (official @modelcontextprotocol/sdk client)
 *   - newline-delimited JSON (handcrafted NDJSON clients)
 *
 * Example MCP config:
 *   {
 *     "mcpServers": {
 *       "windsurf-search": {
 *         "command": "npx",
 *         "args": ["-y", "windsurf-search-mcp"]
 *       }
 *     }
 *   }
 *
 * Auth (never commit secrets):
 *   WINDSURF_API_KEY env, or key file under ~/.config/windsurf-search/api-key
 */
import { resolveApiKey, searchWindsurf } from './windsurf-search.mjs';

const SERVER_INFO = { name: 'windsurf-search-mcp', version: '0.0.1' };
const PROTOCOL_VERSION = '2024-11-05';

const tools = [
  {
    name: 'web_search',
    description:
      'Search the web via Devin/Windsurf server-side search. ' +
      'Returns JSON hits [{title,url,snippet,source}]. ' +
      'Use for current web facts, docs lookups, and general web research.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (required)' },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 10,
          default: 5,
          description: 'Max results (1-10)',
        },
        domain: {
          type: 'string',
          description: 'Optional domain restriction, e.g. github.com',
        },
        mode: { type: 'number', description: 'Optional search mode' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
];

let buffer = '';
let responseFraming = 'ndjson';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  parseBuffer();
});
process.stdin.on('end', () => process.exit(0));

function parseBuffer() {
  // Content-Length framed requests (official SDK client)
  if (/^Content-Length:/im.test(buffer)) {
    responseFraming = 'content-length';
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
      try {
        void handleMessage(JSON.parse(body));
      } catch {
        // ignore malformed JSON-RPC messages
      }
    }
  }

  // Newline-delimited JSON requests (handcrafted client)
  responseFraming = 'ndjson';
  for (;;) {
    const newlineIndex = buffer.indexOf('\n');
    if (newlineIndex === -1) return;
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;
    try {
      void handleMessage(JSON.parse(line));
    } catch {
      // ignore malformed JSON-RPC messages
    }
  }
}

async function handleMessage(message) {
  if (!message || typeof message !== 'object') return;
  const method = typeof message.method === 'string' ? message.method : '';
  const id = message.id;

  if (method === 'initialize') {
    writeResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
    return;
  }
  if (method.startsWith('notifications/')) {
    return;
  }
  if (method === 'tools/list') {
    writeResult(id, { tools });
    return;
  }
  if (method === 'tools/call') {
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    await callTool(toolName, args, id);
    return;
  }
  if (id !== undefined && id !== null) {
    writeResult(id, {});
  }
}

async function callTool(toolName, args, id) {
  if (toolName !== 'web_search') {
    writeError(id, `unknown tool: ${toolName}`);
    return;
  }
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) {
    writeError(id, 'web_search: query is required');
    return;
  }
  try {
    const apiKey = await resolveApiKey({});
    const options = {};
    if (typeof args.limit === 'number' && args.limit > 0) options.limit = args.limit;
    if (typeof args.domain === 'string' && args.domain) options.domain = args.domain;
    if (typeof args.mode === 'number') options.mode = args.mode;
    const hits = await searchWindsurf(apiKey, query, options);
    writeResult(id, { content: [{ type: 'text', text: JSON.stringify({ hits }) }] });
  } catch (error) {
    writeError(id, error instanceof Error ? error.message : String(error));
  }
}

function writeError(id, message) {
  writeResult(id, { isError: true, content: [{ type: 'text', text: message }] });
}

function writeResult(id, result) {
  if (id === undefined || id === null) return;
  const body = JSON.stringify({ jsonrpc: '2.0', id, result });
  if (responseFraming === 'content-length') {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  } else {
    process.stdout.write(`${body}\n`);
  }
}

// Keep the event loop alive while the stdio pipes are idle.
setInterval(() => {}, 1 << 30);
