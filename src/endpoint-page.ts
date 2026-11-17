/* Someone who opens the MCP endpoint in a browser, usually from a directory
   listing or a setup guide, gets a short page that says what the address is
   and links the setup guides, instead of a JSON-RPC error.

   Only a GET or HEAD that accepts text/html and not text/event-stream gets it.
   MCP clients never send that: they POST, and a client opening the optional
   SSE stream must send `Accept: text/event-stream`, which still reaches the
   transport and its 405, the answer the Streamable HTTP spec asks of a server
   that offers no stream. A request with no Accept header, or with curl's
   default wildcard, keeps the 405 too. */

const DOCS_URL = 'https://docs.sqd.dev/en/ai/mcp-server'
const REPO_URL = 'https://github.com/subsquid-labs/portal-mcp-server#readme'

/** Media types an Accept header lists with a quality above zero, lowercased. */
function acceptedTypes(accept: string | undefined): Set<string> {
  const types = new Set<string>()
  for (const entry of (accept ?? '').split(',')) {
    const [type, ...params] = entry.split(';').map((part) => part.trim().toLowerCase())
    const quality = params.find((param) => param.startsWith('q='))
    if (type && !(quality && Number(quality.slice(2)) === 0)) types.add(type)
  }
  return types
}

export function wantsEndpointPage(method: string | undefined, accept: string | undefined): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false
  const types = acceptedTypes(accept)
  return types.has('text/html') && !types.has('text/event-stream')
}

export const ENDPOINT_PAGE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-cache',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  // The setup guide is the page to rank; this one only catches stray visits.
  'X-Robots-Tag': 'noindex',
  Vary: 'Accept',
}

export function renderEndpointPage(version: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SQD Portal MCP server</title>
<style>
:root { color-scheme: light dark; }
body { font: 16px/1.5 system-ui, sans-serif; max-width: 38rem; margin: 0 auto; padding: 3rem 1rem; }
</style>
</head>
<body>
<h1>SQD Portal MCP server</h1>
<p>This address is an MCP endpoint. AI clients connect to it over Streamable HTTP. A browser only gets this page.</p>
<p>To connect, add this URL as a remote MCP server in Claude, ChatGPT, Cursor, Codex or any other client that supports one. It needs no authentication. The server answers read-only questions about blockchain data from SQD Portal.</p>
<ul>
<li><a href="${DOCS_URL}">Setup guide</a> on docs.sqd.dev</li>
<li><a href="${REPO_URL}">Source and per-client instructions</a> on GitHub</li>
</ul>
<p>Version ${version}</p>
</body>
</html>
`
}
