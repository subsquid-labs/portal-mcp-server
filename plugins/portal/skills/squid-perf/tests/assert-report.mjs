import fs from 'node:fs'

const reportPath = process.argv[2]
if (!reportPath) throw new Error('usage: assert-report.mjs <report.html>')

const html = fs.readFileSync(reportPath, 'utf8')
if (html.includes('__bundler/') || /<script[^>]*\ssrc=/i.test(html) || /<link[^>]*\shref=/i.test(html)) {
  throw new Error('report must be a single readable HTML file without packed or external assets')
}
if (!html.includes('id="global-failures"')) {
  throw new Error('global deployment failure mount is missing')
}
if (!html.includes('const globalFailures = data.deploymentFailures || [];')) {
  throw new Error('HTML client does not render deployment failures')
}
const openTag = '<script id="__REPORT_DATA__" type="application/json">'
const openAt = html.indexOf(openTag, html.indexOf('-->') + 3)
const closeAt = html.indexOf('</script>', openAt + openTag.length)
if (openAt < 0 || closeAt < 0) throw new Error('report data not found')

const data = JSON.parse(html.slice(openAt + openTag.length, closeAt))
const service = data.services.find((item) => item.name === 'api')
if (!service) throw new Error('api service missing')
if (service.tier2.baseline.warns !== 1002 || service.tier2.baseline.errors !== 1) {
  throw new Error(`expected uncapped warning and error totals, got ${JSON.stringify(service.tier2.baseline)}`)
}
if (data.deploymentFailures.length !== 2) {
  throw new Error(`expected two deployment failures, got ${JSON.stringify(data.deploymentFailures)}`)
}
if (!data.fetchFailures.includes('experimental')) {
  throw new Error(`expected experimental fetch failure, got ${JSON.stringify(data.fetchFailures)}`)
}
const warningKinds = new Set(data.warnings.map((warning) => warning.kind))
if (!warningKinds.has('fetch-failed') || !warningKinds.has('parse-failed')) {
  throw new Error(`expected fetch and parse warnings, got ${JSON.stringify(data.warnings)}`)
}
