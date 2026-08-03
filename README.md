# windsurf-search-mcp

MCP server **and** CLI for Windsurf/Devin **server-side web search**
(`GetWebSearchResults`).

Zero runtime dependencies. Node.js `>= 20`.

> This talks to Windsurf/Devin cloud endpoints with a personal session token.
> Use at your own risk; tokens expire and may violate the provider's terms if
> used outside the official client.

## Install

```bash
npm i -g windsurf-search-mcp
# or without install:
npx -y windsurf-search-mcp --help
```

## Auth (no secrets in config files)

Resolve order:

1. `--api-key <token>`
2. `WINDSURF_API_KEY` (or legacy `WINDSURFAPI_CODEIUM_API_KEY`)
3. first existing key file:
   - `~/.config/windsurf-search/api-key`
   - `~/.windsurf-search/api-key`
   - `~/.piwin/windsurf-api-key` (compat)

Expected token shape: `devin-session-token$...`

```bash
# interactive (masked)
windsurf-search config set

# or non-interactive
windsurf-search config set 'devin-session-token$...'

windsurf-search config show
windsurf-search config test
```

Email/password login is also available (`windsurf-search --login`), but many
accounts are OAuth-only and will reject password login.

## CLI

```bash
windsurf-search "tauri window drag region" --limit 5
# stdout JSON:
# { "hits": [ { "title", "url", "snippet", "source": "windsurf" } ] }
```

Useful for agent hosts that spawn a custom CLI search source and parse JSON hits.

## MCP server

### Cursor / Claude Desktop / generic MCP host

```json
{
  "mcpServers": {
    "windsurf-search": {
      "command": "npx",
      "args": ["-y", "windsurf-search-mcp"],
      "env": {
        "WINDSURF_API_KEY": "devin-session-token$..."
      }
    }
  }
}
```

Prefer putting the token in a key file and **omitting** `env` entirely:

```json
{
  "mcpServers": {
    "windsurf-search": {
      "command": "npx",
      "args": ["-y", "windsurf-search-mcp"]
    }
  }
}
```

Then:

```bash
windsurf-search config set
```

### Exposed tool

`web_search`

| arg | type | required | notes |
|-----|------|----------|-------|
| `query` | string | yes | search query |
| `limit` | number | no | 1–10, default 5 |
| `domain` | string | no | optional domain filter |
| `mode` | number | no | optional upstream mode |

Returns MCP text content with JSON:

```json
{ "hits": [ { "title": "...", "url": "...", "snippet": "...", "source": "windsurf" } ] }
```

## Development

```bash
node --test test/*.mjs          # offline unit + protocol tests
RUN_LIVE_SEARCH=1 npm test      # also hit live API if key is configured
```

## Security notes

- Never commit real tokens.
- Session tokens expire; re-run `config set` when searches return 401.
- `config show` only prints a masked key.
- This is **not** an official Windsurf/Devin product.

## License

MIT
