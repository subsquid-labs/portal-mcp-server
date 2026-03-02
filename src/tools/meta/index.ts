import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { formatResult } from '../../helpers/format.js'
import { suggestTool } from './suggest-tool.js'

export function registerSuggestToolTool(server: McpServer) {
  server.tool(
    'portal_suggest_tool',
    'Suggests which Portal tools to use based on a natural language question. Zero cost - pure logic, no API calls.',
    {
      question: z.string().describe('Natural language question about blockchain data'),
      dataset: z.string().optional().describe("Dataset/chain if mentioned (e.g., 'ethereum', 'base-mainnet')"),
    },
    async ({ question, dataset }) => {
      const result = await suggestTool({ question, dataset })
      return formatResult(result, `Found ${result.suggestions.length} tool suggestions for: "${result.question}"`)
    },
  )
}
