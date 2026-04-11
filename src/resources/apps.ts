import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'

import { PORTAL_APP_RESOURCE_URI } from '../constants/apps.js'
import { PORTAL_APP_HTML } from '../generated/portal-app.generated.js'

export function registerAppResources(server: McpServer) {
  registerAppResource(
    server,
    'portal-app',
    PORTAL_APP_RESOURCE_URI,
    {
      title: 'Portal Explorer',
      description: 'Interactive charts, tables, and investigation views for Portal MCP results.',
      mimeType: RESOURCE_MIME_TYPE,
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: RESOURCE_MIME_TYPE,
          text: PORTAL_APP_HTML,
        },
      ],
    }),
  )
}
