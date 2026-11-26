import { Buffer } from 'node:buffer'

import type { Icon } from '@modelcontextprotocol/server'

/**
 * Official SQD brand mark (306x306, black square with white wave monogram),
 * matching the embedded SVG mark in SQD Explorer.
 */
const SQD_MARK_SVG =
  '<svg viewBox="0 0 306 306" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="306" height="306" fill="#000000"/><path d="M208.004 125.812C180.366 125.812 166.754 135.622 152.344 146.003C136.923 157.109 120.961 168.6 89.1939 168.6C84.5804 168.6 80.2945 168.344 76.3076 167.902V229.358H228.665V128.019C222.699 126.623 215.921 125.812 208.004 125.812Z" fill="#FFFFFF"/><path d="M89.1084 120.614C84.7655 120.614 80.4938 120.301 76.2933 119.746V154.987C80.2375 155.5 84.5092 155.784 89.1796 155.784C116.818 155.784 130.43 145.974 144.84 135.594C160.261 124.487 176.223 112.996 207.99 112.996C215.75 112.996 222.556 113.68 228.651 114.89V77H170.157C152.728 103.257 122.912 120.614 89.1084 120.614Z" fill="#FFFFFF"/><path d="M76.2933 106.831C80.4796 107.471 84.7513 107.799 89.1084 107.799C115.308 107.799 138.76 95.7955 154.252 77H76.2933V106.817V106.831Z" fill="#FFFFFF"/></svg>'

export const SQD_ICON_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(SQD_MARK_SVG, 'utf8').toString('base64')}`

export const SQD_SERVER_ICONS: Icon[] = [
  {
    src: SQD_ICON_DATA_URI,
    mimeType: 'image/svg+xml',
    sizes: ['any'],
  },
]
