import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareCredentialBroker } from './macos-credential-broker.mjs'
import {
  LOCAL_SIGNING_CONFIG_VERSION,
  listCodeSigningIdentities,
  localSigningConfigPath,
  normalizeFingerprint,
  readLocalSigningConfig,
  readProjectMetadata,
  runCommand,
} from './macos-signing.mjs'

function argumentValue(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) {
    return undefined
  }
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value.`)
  }
  return value
}

function parseValidityDays() {
  const rawValue =
    argumentValue('--days') ?? process.env.CODE_ASSISTANT_LOCAL_SIGNING_DAYS ?? '3650'
  const days = Number(rawValue)
  if (!Number.isSafeInteger(days) || days < 30 || days > 3650) {
    throw new Error('--days must be an integer between 30 and 3650.')
  }
  return days
}

function defaultUserKeychain() {
  const output = runCommand('/usr/bin/security', ['default-keychain', '-d', 'user']).trim()
  const keychain = output.replace(/^"|"$/gu, '')
  if (!isAbsolute(keychain) || !existsSync(keychain)) {
    throw new Error(`Unable to resolve the default user keychain: ${keychain}`)
  }
  return keychain
}

function certificateCommonName(productName) {
  const safeProductName = productName
    .replaceAll(/[^\p{L}\p{N} ._-]/gu, ' ')
    .trim()
    .slice(0, 40)
  const suffix = randomBytes(6).toString('hex')
  return `Local Code Signing - ${safeProductName || 'Application'} - ${suffix}`
}

function opensslConfiguration(commonName) {
  return `[req]
distinguished_name = subject
prompt = no
x509_extensions = extensions

[subject]
CN = ${commonName}

[extensions]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
`
}

function writeConfigAtomically(configPath, config) {
  const configDirectory = dirname(configPath)
  mkdirSync(configDirectory, { mode: 0o700, recursive: true })
  chmodSync(configDirectory, 0o700)
  const temporaryPath = join(configDirectory, `.${basename(configPath)}.${process.pid}.tmp`)
  writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  chmodSync(temporaryPath, 0o600)
  renameSync(temporaryPath, configPath)
  chmodSync(configPath, 0o600)
}

if (process.platform !== 'darwin') {
  throw new Error('Local macOS signing setup can only run on macOS.')
}

if (process.env.CSC_LINK?.trim() || process.env.CSC_NAME?.trim()) {
  throw new Error('External CSC credentials are already configured; local setup is unnecessary.')
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const metadata = readProjectMetadata(projectRoot)
const configPath = localSigningConfigPath(metadata)
const replace = process.argv.includes('--replace')
const replaceBroker = replace || process.argv.includes('--replace-broker')
let existing
try {
  existing = readLocalSigningConfig(configPath, metadata, { optional: true })
} catch (error) {
  if (!replace) {
    throw error
  }
  console.warn(`Replacing unreadable local signing config: ${configPath}`)
  existing = null
}

let activeIdentity
let createdIdentity = null

if (existing && !replace) {
  const available = listCodeSigningIdentities(existing.keychain).some(
    (identity) => identity.fingerprint === existing.certificateSha1,
  )
  if (!available) {
    throw new Error(
      `The saved local identity is unavailable. Re-run with --replace. Config: ${configPath}`,
    )
  }
  activeIdentity = {
    certificateCommonName: existing.certificateCommonName,
    certificateSha1: existing.certificateSha1,
    createdAt: existing.createdAt ?? new Date().toISOString(),
    keychain: existing.keychain,
  }
  console.log(`Reusing local signing identity ${existing.certificateSha1}.`)
} else {
  const requestedKeychain =
    argumentValue('--keychain') ?? process.env.CODE_ASSISTANT_SIGNING_KEYCHAIN
  const keychain = requestedKeychain ? resolve(requestedKeychain) : defaultUserKeychain()
  if (!isAbsolute(keychain) || !existsSync(keychain)) {
    throw new Error(`The selected keychain does not exist: ${keychain}`)
  }

  const workingDirectory = mkdtempSync(join(tmpdir(), 'code-assistant-local-signing-'))
  chmodSync(workingDirectory, 0o700)
  const certificatePath = join(workingDirectory, 'certificate.pem')
  const privateKeyPath = join(workingDirectory, 'private-key.pem')
  const identityPath = join(workingDirectory, 'identity.p12')
  const opensslConfigPath = join(workingDirectory, 'openssl.cnf')
  const commonName = certificateCommonName(metadata.productName)
  let certificateSha1

  try {
    const archivePassword = randomBytes(32).toString('base64url')
    writeFileSync(opensslConfigPath, opensslConfiguration(commonName), { mode: 0o600 })
    runCommand('/usr/bin/openssl', [
      'req',
      '-new',
      '-x509',
      '-newkey',
      'rsa:3072',
      '-sha256',
      '-nodes',
      '-days',
      String(parseValidityDays()),
      '-keyout',
      privateKeyPath,
      '-out',
      certificatePath,
      '-config',
      opensslConfigPath,
      '-extensions',
      'extensions',
    ])
    chmodSync(privateKeyPath, 0o600)

    const fingerprintOutput = runCommand('/usr/bin/openssl', [
      'x509',
      '-in',
      certificatePath,
      '-noout',
      '-fingerprint',
      '-sha1',
    ])
    const fingerprintMatch = fingerprintOutput.match(/Fingerprint=([0-9A-F:]{59})/iu)
    if (!fingerprintMatch) {
      throw new Error('Unable to calculate the generated certificate fingerprint.')
    }
    certificateSha1 = normalizeFingerprint(fingerprintMatch[1])

    runCommand('/usr/bin/openssl', [
      'pkcs12',
      '-export',
      '-inkey',
      privateKeyPath,
      '-in',
      certificatePath,
      '-out',
      identityPath,
      '-name',
      commonName,
      '-passout',
      `pass:${archivePassword}`,
    ])
    chmodSync(identityPath, 0o600)
    runCommand('/usr/bin/security', [
      'import',
      identityPath,
      '-k',
      keychain,
      '-f',
      'pkcs12',
      '-P',
      archivePassword,
      '-x',
      '-T',
      '/usr/bin/codesign',
    ])
    runCommand('/usr/bin/security', [
      'add-trusted-cert',
      '-r',
      'trustRoot',
      '-p',
      'codeSign',
      '-k',
      keychain,
      certificatePath,
    ])

    const available = listCodeSigningIdentities(keychain).some(
      (identity) => identity.fingerprint === certificateSha1,
    )
    if (!available) {
      throw new Error('The generated certificate is not a valid code-signing identity.')
    }

    activeIdentity = {
      certificateCommonName: commonName,
      certificateSha1,
      createdAt: new Date().toISOString(),
      keychain,
    }
    createdIdentity = { certificateSha1, keychain }
  } catch (error) {
    if (certificateSha1) {
      spawnCleanup('/usr/bin/security', ['delete-identity', '-Z', certificateSha1, '-t', keychain])
      spawnCleanup('/usr/bin/security', [
        'delete-certificate',
        '-Z',
        certificateSha1,
        '-t',
        keychain,
      ])
    }
    throw error
  } finally {
    rmSync(workingDirectory, { force: true, recursive: true })
  }

  console.log(`Created local signing identity ${certificateSha1}.`)
  console.log(`Private key: non-extractable in ${keychain}`)
}

try {
  const credentialBroker = prepareCredentialBroker({
    certificateSha1: activeIdentity.certificateSha1,
    configPath,
    existingBroker: replace ? null : existing?.credentialBroker,
    keychain: activeIdentity.keychain,
    metadata,
    projectRoot,
    replace: replaceBroker,
  })
  writeConfigAtomically(configPath, {
    appId: metadata.appId,
    ...activeIdentity,
    credentialBroker,
    version: LOCAL_SIGNING_CONFIG_VERSION,
  })

  // Keep the previous identity available until its replacement broker and config are durable.
  if (existing && replace) {
    spawnCleanup('/usr/bin/security', [
      'delete-identity',
      '-Z',
      existing.certificateSha1,
      '-t',
      existing.keychain,
    ])
  }
  console.log(`Credential broker CDHash: ${credentialBroker.cdHash}`)
  console.log(`Config: ${configPath}`)
} catch (error) {
  if (createdIdentity) {
    spawnCleanup('/usr/bin/security', [
      'delete-identity',
      '-Z',
      createdIdentity.certificateSha1,
      '-t',
      createdIdentity.keychain,
    ])
    spawnCleanup('/usr/bin/security', [
      'delete-certificate',
      '-Z',
      createdIdentity.certificateSha1,
      '-t',
      createdIdentity.keychain,
    ])
  }
  throw error
}

function spawnCleanup(command, args) {
  try {
    runCommand(command, args)
  } catch {
    // Preserve the original setup error; cleanup is best effort.
  }
}
