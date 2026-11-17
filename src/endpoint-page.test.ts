import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ENDPOINT_PAGE_HEADERS, renderEndpointPage, wantsEndpointPage } from './endpoint-page.js'

const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'

describe('endpoint page selection', () => {
  it('serves the page to a browser GET or HEAD', () => {
    assert.equal(wantsEndpointPage('GET', BROWSER_ACCEPT), true)
    assert.equal(wantsEndpointPage('HEAD', 'text/html'), true)
    assert.equal(wantsEndpointPage('GET', 'TEXT/HTML; charset=utf-8'), true)
  })

  it('leaves every MCP transport request to the transport', () => {
    assert.equal(wantsEndpointPage('GET', 'text/event-stream'), false)
    assert.equal(wantsEndpointPage('GET', 'application/json, text/event-stream'), false)
    assert.equal(wantsEndpointPage('GET', `${BROWSER_ACCEPT}, text/event-stream`), false)
    assert.equal(wantsEndpointPage('POST', BROWSER_ACCEPT), false)
    assert.equal(wantsEndpointPage('DELETE', BROWSER_ACCEPT), false)
  })

  it('keeps the 405 when text/html is not asked for or is refused', () => {
    assert.equal(wantsEndpointPage('GET', undefined), false)
    assert.equal(wantsEndpointPage('GET', ''), false)
    assert.equal(wantsEndpointPage('GET', '*/*'), false)
    assert.equal(wantsEndpointPage('GET', 'text/html;q=0, */*'), false)
  })

  it('serves the page when the client refuses an event stream', () => {
    assert.equal(wantsEndpointPage('GET', 'text/html, text/event-stream;q=0'), true)
  })
})

describe('endpoint page', () => {
  it('names the server and version and links the setup guides', () => {
    const html = renderEndpointPage('9.9.9')
    assert.match(html, /<title>SQD Portal MCP server<\/title>/)
    assert.match(html, /Version 9\.9\.9/)
    assert.match(html, /href="https:\/\/docs\.sqd\.dev\/en\/ai\/mcp-server"/)
    assert.match(html, /href="https:\/\/github\.com\/subsquid-labs\/portal-mcp-server#readme"/)
  })

  it('varies on Accept and stays out of search results', () => {
    assert.equal(ENDPOINT_PAGE_HEADERS.Vary, 'Accept')
    assert.equal(ENDPOINT_PAGE_HEADERS['X-Robots-Tag'], 'noindex')
    assert.match(ENDPOINT_PAGE_HEADERS['Content-Type'] ?? '', /^text\/html/)
  })
})
