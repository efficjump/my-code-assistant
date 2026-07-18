import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { credentialBrokerSourceDigest } from './macos-credential-broker.mjs'
import {
  CREDENTIAL_BROKER_RESOURCE_PATH,
  electronBuilderArguments,
  findFreshMacAppBundles,
  findMacAppBundles,
  findRunningMacBundleProcesses,
  localCredentialBrokerBuildConfiguration,
  readProjectMetadata,
  resolveMacSigningEnvironment,
  runCommand,
  safeStorageBuildConfiguration,
  verifyCredentialBrokerArtifact,
  verifyMacAppSignature,
} from './macos-signing.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const metadata = readProjectMetadata(projectRoot)
let environment = process.env
let signing = null

if (process.platform === 'darwin') {
  try {
    signing = resolveMacSigningEnvironment(metadata)
    environment = signing.env
  } catch (error) {
    console.error(`macOS packaging requires a stable signing identity: ${error.message}`)
    console.error('Configure external CSC credentials or run "pnpm signing:setup:mac" once.')
    process.exitCode = 1
  }
}

if (process.exitCode !== 1) {
  if (process.platform === 'darwin') {
    const existingAppBundles = findMacAppBundles(metadata)
    const runningBundles = findRunningMacBundleProcesses(
      runCommand('/bin/ps', ['-axo', 'pid=,command=']),
      existingAppBundles,
      metadata.productName,
    )
    if (runningBundles.length > 0) {
      const details = runningBundles
        .map(({ appPath, pid }) => `${appPath} (PID ${String(pid)})`)
        .join(', ')
      throw new Error(
        `Quit ${metadata.productName} before packaging. Replacing a running signed bundle invalidates its live code identity and credential broker access: ${details}`,
      )
    }
  }

  const builtAfter = Date.now()
  let temporaryConfigurationDirectory = null
  try {
    let builderArguments = electronBuilderArguments(signing?.source)
    if (process.platform === 'darwin') {
      temporaryConfigurationDirectory = mkdtempSync(
        join(tmpdir(), 'code-assistant-electron-builder-'),
      )
      const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
      let configuration
      if (signing.source === 'local-keychain') {
        const currentSourceDigest = credentialBrokerSourceDigest(
          projectRoot,
          metadata,
          signing.credentialBroker.architecture,
          signing.credentialBroker.keyId,
        )
        if (currentSourceDigest !== signing.credentialBroker.sourceDigest) {
          throw new Error(
            'Credential broker source changed after signing setup. Run "pnpm signing:setup:mac -- --replace-broker" before packaging.',
          )
        }
        verifyCredentialBrokerArtifact(
          signing.credentialBroker.artifactPath,
          metadata,
          signing.expectedCertificateSha1,
          signing.credentialBroker,
        )
        configuration = localCredentialBrokerBuildConfiguration(
          packageJson.build ?? {},
          signing.credentialBroker,
        )
      } else {
        configuration = safeStorageBuildConfiguration(packageJson.build ?? {})
      }
      const configurationPath = join(temporaryConfigurationDirectory, 'electron-builder.json')
      writeFileSync(configurationPath, `${JSON.stringify(configuration, null, 2)}\n`, {
        mode: 0o600,
      })
      builderArguments = ['--dir', '--config', configurationPath]
    }
    runCommand(join(projectRoot, 'node_modules', '.bin', 'electron-builder'), builderArguments, {
      cwd: projectRoot,
      env: environment,
      inherit: true,
    })
  } finally {
    if (temporaryConfigurationDirectory) {
      rmSync(temporaryConfigurationDirectory, { recursive: true, force: true })
    }
  }

  if (process.platform === 'darwin') {
    const appBundles = findFreshMacAppBundles(metadata, builtAfter)
    if (appBundles.length === 0) {
      throw new Error(
        `No freshly signed ${metadata.productName}.app was found below ${metadata.outputDirectory}.`,
      )
    }

    for (const appPath of appBundles) {
      const evidence = verifyMacAppSignature(appPath, metadata, signing.expectedCertificateSha1)
      if (signing.source === 'local-keychain') {
        const packagedBrokerPath = join(appPath, CREDENTIAL_BROKER_RESOURCE_PATH)
        const brokerEvidence = verifyCredentialBrokerArtifact(
          packagedBrokerPath,
          metadata,
          signing.expectedCertificateSha1,
          signing.credentialBroker,
        )
        console.log(`  credential broker CDHash: ${brokerEvidence.cdHash}`)
      }
      console.log(`Verified stable macOS signature: ${evidence.appPath}`)
      console.log(`  certificate SHA-1: ${evidence.certificateSha1}`)
      console.log(`  designated requirement: ${evidence.requirement}`)
    }
  }
}
