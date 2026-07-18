import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from '@playwright/test'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputPath = join(repositoryRoot, 'docs', 'assets', 'application-overview.png')
const temporaryRoot = await mkdtemp(join(tmpdir(), 'code-assistant-readme-'))
const userDataPath = join(temporaryRoot, 'user-data')
const provider = createServer((request, response) => {
  if (
    request.method === 'GET' &&
    new URL(request.url ?? '/', 'http://127.0.0.1').pathname === '/v1/models'
  ) {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(
      JSON.stringify({
        object: 'list',
        data: [{ id: 'demo-model', object: 'model', created: 1, owned_by: 'local-demo' }],
      }),
    )
    return
  }
  response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify({ error: { message: 'Not found' } }))
})

await new Promise((resolvePromise, reject) => {
  provider.once('error', reject)
  provider.listen(0, '127.0.0.1', () => {
    provider.removeListener('error', reject)
    resolvePromise()
  })
})
const providerAddress = provider.address()
if (!providerAddress || typeof providerAddress === 'string') {
  throw new Error('The screenshot provider address is unavailable.')
}
const providerBaseUrl = `http://127.0.0.1:${providerAddress.port}/v1`

let application
try {
  application = await electron.launch({
    args: [repositoryRoot, `--user-data-dir=${userDataPath}`],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'false',
    },
    timeout: 30_000,
  })
  const page = await application.firstWindow({ timeout: 30_000 })
  await page.waitForLoadState('domcontentloaded')
  const localeSelect = page.locator('select').filter({ has: page.locator('option[value="en"]') })
  await localeSelect.selectOption('en')
  await page.locator('html[lang="en"]').waitFor()

  await page.evaluate(async (baseUrl) => {
    const withProvider = await window.assistant.saveProvider({
      name: 'Local demo',
      baseUrl,
    })
    const provider = withProvider.providers[0]
    if (!provider) throw new Error('The screenshot provider was not saved.')
    await window.assistant.saveSettings({
      activeProviderId: provider.id,
      activeModelId: 'demo-model',
      theme: 'dark',
      locale: 'en',
      maxToolIterations: withProvider.maxToolIterations,
      maxTotalToolCalls: withProvider.maxTotalToolCalls,
      runTimeoutMinutes: withProvider.runTimeoutMinutes,
    })
  }, providerBaseUrl)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'What would you like to build today?' }).waitFor()

  const bodyText = await page.locator('body').innerText()
  if (
    bodyText.includes(temporaryRoot) ||
    /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)/.test(bodyText)
  ) {
    throw new Error('The screenshot view contains a machine-specific path.')
  }

  await mkdir(dirname(outputPath), { recursive: true })
  await page.screenshot({
    path: outputPath,
    type: 'png',
    animations: 'disabled',
  })
  process.stdout.write('Updated docs/assets/application-overview.png\n')
} finally {
  await application?.close().catch(() => undefined)
  await new Promise((resolvePromise) => provider.close(() => resolvePromise()))
  await rm(temporaryRoot, { recursive: true, force: true })
}
