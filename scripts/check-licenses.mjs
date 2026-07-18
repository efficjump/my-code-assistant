import { spawnSync } from 'node:child_process'

const windows = process.platform === 'win32'
const licenseArguments = ['licenses', 'list', '--prod', '--json']
const result = spawnSync(
  windows ? `pnpm ${licenseArguments.join(' ')}` : 'pnpm',
  windows ? [] : licenseArguments,
  {
    encoding: 'utf8',
    shell: windows,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)

if (result.error || result.status !== 0) {
  process.stderr.write(result.stderr || 'Unable to inspect production dependency licenses.\n')
  process.exit(result.status ?? 1)
}

let report
try {
  report = JSON.parse(result.stdout)
} catch {
  process.stderr.write('The dependency license report was not valid JSON.\n')
  process.exit(1)
}

if (!report || typeof report !== 'object' || Array.isArray(report)) {
  process.stderr.write('The dependency license report had an unexpected shape.\n')
  process.exit(1)
}

const categories = Object.keys(report).sort((left, right) => left.localeCompare(right))
const unrecognized = categories.filter((category) =>
  /(?:unknown|unlicensed|not specified|see license)/i.test(category),
)

if (categories.length === 0 || unrecognized.length > 0) {
  process.stderr.write(
    unrecognized.length > 0
      ? `Unrecognized production dependency licenses: ${unrecognized.join(', ')}\n`
      : 'No production dependency licenses were reported.\n',
  )
  process.exit(1)
}

process.stdout.write(`Production dependency license categories: ${categories.join(', ')}\n`)
