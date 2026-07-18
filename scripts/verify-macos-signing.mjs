import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { credentialBrokerSourceDigest } from './macos-credential-broker.mjs'
import {
  CREDENTIAL_BROKER_RESOURCE_PATH,
  readProjectMetadata,
  resolveMacSigningEnvironment,
  verifyCredentialBrokerArtifact,
  verifyMacAppSignature,
} from './macos-signing.mjs'

if (process.platform !== 'darwin') {
  throw new Error('macOS signature verification can only run on macOS.')
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const metadata = readProjectMetadata(projectRoot)
const signing = resolveMacSigningEnvironment(metadata)
const positionalArguments = process.argv.slice(2)
if (positionalArguments[0] === '--') positionalArguments.shift()
const appPath = positionalArguments.length === 1 ? positionalArguments[0] : undefined

if (!appPath) {
  throw new Error('Usage: pnpm signing:verify:mac -- /absolute/path/to/Application.app')
}

const evidence = verifyMacAppSignature(appPath, metadata, signing.expectedCertificateSha1)
if (signing.source === 'local-keychain') {
  const currentSourceDigest = credentialBrokerSourceDigest(
    projectRoot,
    metadata,
    signing.credentialBroker.architecture,
    signing.credentialBroker.keyId,
  )
  if (currentSourceDigest !== signing.credentialBroker.sourceDigest) {
    throw new Error(
      'Credential broker source changed after signing setup. Rotate and repackage the broker before verification.',
    )
  }
  const brokerEvidence = verifyCredentialBrokerArtifact(
    join(evidence.appPath, CREDENTIAL_BROKER_RESOURCE_PATH),
    metadata,
    signing.expectedCertificateSha1,
    signing.credentialBroker,
  )
  console.log(`  credential broker CDHash: ${brokerEvidence.cdHash}`)
  console.log(`  credential broker key ID: ${signing.credentialBroker.keyId}`)
}
console.log(`Verified stable macOS signature: ${evidence.appPath}`)
console.log(`  certificate SHA-1: ${evidence.certificateSha1}`)
console.log(`  authorities: ${evidence.authorities.join(' -> ')}`)
console.log(`  designated requirement: ${evidence.requirement}`)
