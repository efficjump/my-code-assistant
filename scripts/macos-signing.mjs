import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'

export const LOCAL_SIGNING_CONFIG_VERSION = 3
export const LEGACY_LOCAL_SIGNING_CONFIG_VERSION = 1
export const PREVIOUS_LOCAL_SIGNING_CONFIG_VERSION = 2
export const CREDENTIAL_BROKER_PROTOCOL_VERSION = 2
export const CREDENTIAL_BACKEND_METADATA_KEY = 'codeAssistantCredentialBackend'
export const CREDENTIAL_BROKER_RESOURCE_PATH = join(
  'Contents',
  'Resources',
  'credential-broker',
  'credential-broker',
)

function present(value) {
  return typeof value === 'string' && value.trim().length > 0
}

export function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

export function normalizeFingerprint(value) {
  return value.replaceAll(':', '').trim().toUpperCase()
}

export function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env ?? process.env,
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  })

  if (result.error) {
    throw new Error(`Unable to execute ${basename(command)}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout]
      .filter(present)
      .map((value) => value.trim())
      .join('\n')
    throw new Error(
      `${basename(command)} exited with status ${String(result.status)}${detail ? `:\n${detail}` : ''}`,
    )
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

export function readProjectMetadata(projectRoot) {
  const packagePath = join(projectRoot, 'package.json')
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))
  const appId = packageJson.build?.appId
  const productName = packageJson.build?.productName
  const outputDirectory = packageJson.build?.directories?.output ?? 'dist'

  if (!present(packageJson.name) || !present(appId) || !present(productName)) {
    throw new Error('package.json must define name, build.appId, and build.productName.')
  }
  if (!present(outputDirectory)) {
    throw new Error('build.directories.output must be a non-empty path when provided.')
  }

  return {
    appId: appId.trim(),
    outputDirectory: resolve(projectRoot, outputDirectory),
    packageName: packageJson.name.trim(),
    productName: productName.trim(),
  }
}

export function localSigningConfigPath(metadata, env = process.env) {
  if (present(env.CODE_ASSISTANT_SIGNING_CONFIG)) {
    return resolve(env.CODE_ASSISTANT_SIGNING_CONFIG.trim())
  }
  const applicationDirectory = metadata.packageName.replaceAll(/[^a-zA-Z0-9._-]/gu, '_')
  return join(
    homedir(),
    'Library',
    'Application Support',
    applicationDirectory,
    'macos-signing.json',
  )
}

export function parseIdentityListing(output) {
  const identities = []
  const linePattern = /^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/gimu
  for (const match of output.matchAll(linePattern)) {
    identities.push({ fingerprint: normalizeFingerprint(match[1]), name: match[2] })
  }
  return identities
}

export function identityMatches(identity, qualifier) {
  const normalizedQualifier = normalizeFingerprint(qualifier)
  if (/^[0-9A-F]{40}$/u.test(normalizedQualifier)) {
    return identity.fingerprint === normalizedQualifier
  }
  return identity.name.includes(qualifier.trim())
}

export function selectUniqueIdentity(identities, qualifier) {
  const matches = identities.filter((identity) => identityMatches(identity, qualifier))
  if (matches.length === 0) {
    throw new Error(
      'CSC_NAME does not match a valid code-signing identity in the selected keychain.',
    )
  }
  if (matches.length > 1) {
    throw new Error(
      `CSC_NAME is ambiguous and matches ${String(matches.length)} code-signing identities; use the exact certificate SHA-1 fingerprint.`,
    )
  }
  return matches[0]
}

export function listCodeSigningIdentities(keychain) {
  const args = ['find-identity', '-v', '-p', 'codesigning']
  if (present(keychain)) {
    args.push(keychain)
  }
  return parseIdentityListing(runCommand('/usr/bin/security', args))
}

function validateLocalSigningConfig(value, metadata, configPath) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Local signing config is not an object: ${configPath}`)
  }
  if (
    value.version !== LOCAL_SIGNING_CONFIG_VERSION &&
    value.version !== LEGACY_LOCAL_SIGNING_CONFIG_VERSION &&
    value.version !== PREVIOUS_LOCAL_SIGNING_CONFIG_VERSION
  ) {
    throw new Error(`Unsupported local signing config version in ${configPath}.`)
  }
  if (value.appId !== metadata.appId) {
    throw new Error(
      `Local signing config belongs to ${String(value.appId)}, not ${metadata.appId}: ${configPath}`,
    )
  }

  const fingerprint = normalizeFingerprint(String(value.certificateSha1 ?? ''))
  if (!/^[0-9A-F]{40}$/u.test(fingerprint)) {
    throw new Error(`Local signing config has an invalid certificate fingerprint: ${configPath}`)
  }
  if (!present(value.keychain) || !isAbsolute(value.keychain)) {
    throw new Error(`Local signing config must contain an absolute keychain path: ${configPath}`)
  }
  if (!present(value.certificateCommonName)) {
    throw new Error(`Local signing config has no certificate common name: ${configPath}`)
  }

  let credentialBroker = null
  if (value.version === LOCAL_SIGNING_CONFIG_VERSION) {
    const broker = value.credentialBroker
    if (!broker || typeof broker !== 'object' || Array.isArray(broker)) {
      throw new Error(`Local signing config has no credential broker: ${configPath}`)
    }
    const artifactPath = String(broker.artifactPath ?? '')
    const sourceDigest = String(broker.sourceDigest ?? '').toLowerCase()
    const executableSha256 = String(broker.executableSha256 ?? '').toLowerCase()
    const cdHash = String(broker.cdHash ?? '').toLowerCase()
    const identifier = String(broker.identifier ?? '')
    const keyId = String(broker.keyId ?? '')
    const architecture = String(broker.architecture ?? '')
    if (!isAbsolute(artifactPath)) {
      throw new Error(`Credential broker artifact path must be absolute: ${configPath}`)
    }
    if (!/^[0-9a-f]{64}$/u.test(sourceDigest) || !/^[0-9a-f]{64}$/u.test(executableSha256)) {
      throw new Error(`Credential broker digest is invalid: ${configPath}`)
    }
    if (!/^[0-9a-f]{40,64}$/u.test(cdHash)) {
      throw new Error(`Credential broker CDHash is invalid: ${configPath}`)
    }
    if (identifier !== `${metadata.appId}.credential-broker`) {
      throw new Error(`Credential broker identifier is invalid: ${configPath}`)
    }
    if (!/^[0-9a-f]{32}$/u.test(keyId)) {
      throw new Error(`Credential broker key ID is invalid: ${configPath}`)
    }
    if (!['arm64', 'x64'].includes(architecture)) {
      throw new Error(`Credential broker architecture is unsupported: ${configPath}`)
    }
    if (broker.protocolVersion !== CREDENTIAL_BROKER_PROTOCOL_VERSION) {
      throw new Error(`Credential broker protocol version is unsupported: ${configPath}`)
    }
    credentialBroker = {
      architecture,
      artifactPath,
      cdHash,
      executableSha256,
      identifier,
      keyId,
      protocolVersion: broker.protocolVersion,
      sourceDigest,
    }
  }

  return {
    appId: value.appId,
    certificateCommonName: value.certificateCommonName.trim(),
    certificateSha1: fingerprint,
    createdAt: present(value.createdAt) ? value.createdAt : undefined,
    credentialBroker,
    keychain: value.keychain,
    version: value.version,
  }
}

export function readLocalSigningConfig(configPath, metadata, options = {}) {
  let fileStat
  try {
    fileStat = lstatSync(configPath)
  } catch (error) {
    if (error?.code === 'ENOENT' && options.optional) {
      return null
    }
    if (error?.code === 'ENOENT') {
      throw new Error(
        `No local signing config exists. Run "pnpm signing:setup:mac". Config: ${configPath}`,
      )
    }
    throw error
  }

  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw new Error(`Local signing config is not a regular file: ${configPath}`)
  }
  if (typeof process.getuid === 'function' && fileStat.uid !== process.getuid()) {
    throw new Error(`Local signing config is not owned by the current user: ${configPath}`)
  }
  if ((fileStat.mode & 0o077) !== 0) {
    throw new Error(`Local signing config permissions must be 0600: ${configPath}`)
  }

  return validateLocalSigningConfig(
    JSON.parse(readFileSync(configPath, 'utf8')),
    metadata,
    configPath,
  )
}

export function resolveMacSigningEnvironment(metadata, env = process.env) {
  const externalLink = present(env.CSC_LINK)
  const externalName = present(env.CSC_NAME)

  if (externalName && env.CSC_NAME.trim() === '-') {
    throw new Error('Ad-hoc signing (CSC_NAME="-") is not allowed for macOS packages.')
  }

  if (externalLink || externalName) {
    let expectedCertificateSha1
    if (!externalLink) {
      const identities = listCodeSigningIdentities(env.CSC_KEYCHAIN)
      const selectedIdentity = selectUniqueIdentity(identities, env.CSC_NAME)
      expectedCertificateSha1 = selectedIdentity.fingerprint
    }
    return {
      env: { ...env },
      expectedCertificateSha1,
      source: externalLink ? 'external-certificate' : 'external-keychain',
    }
  }

  const configPath = localSigningConfigPath(metadata, env)
  const config = readLocalSigningConfig(configPath, metadata)
  if (!config.credentialBroker) {
    throw new Error(
      `The local signing config predates the credential broker. Run "pnpm signing:setup:mac". Config: ${configPath}`,
    )
  }
  const identities = listCodeSigningIdentities(config.keychain)
  if (!identities.some((identity) => identity.fingerprint === config.certificateSha1)) {
    throw new Error(
      `The configured local signing identity is unavailable. Run "pnpm signing:setup:mac -- --replace". Config: ${configPath}`,
    )
  }

  return {
    env: {
      ...env,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      CSC_KEYCHAIN: config.keychain,
      CSC_NAME: config.certificateSha1,
    },
    expectedCertificateSha1: config.certificateSha1,
    credentialBroker: config.credentialBroker,
    source: 'local-keychain',
  }
}

export function electronBuilderArguments(signingSource) {
  return signingSource === 'local-keychain' ? ['--dir', '--config.mac.timestamp=none'] : ['--dir']
}

function credentialBackendMetadataConfiguration(baseConfiguration, credentialBackend) {
  return {
    ...baseConfiguration,
    extraMetadata: {
      ...baseConfiguration.extraMetadata,
      [CREDENTIAL_BACKEND_METADATA_KEY]: credentialBackend,
    },
  }
}

export function safeStorageBuildConfiguration(baseConfiguration) {
  return credentialBackendMetadataConfiguration(baseConfiguration, {
    kind: 'electron-safe-storage-v1',
  })
}

export function localCredentialBrokerBuildConfiguration(baseConfiguration, credentialBroker) {
  const existingExtraResources = baseConfiguration.extraResources
    ? Array.isArray(baseConfiguration.extraResources)
      ? baseConfiguration.extraResources
      : [baseConfiguration.extraResources]
    : []
  const existingSignIgnore = baseConfiguration.mac?.signIgnore
    ? Array.isArray(baseConfiguration.mac.signIgnore)
      ? baseConfiguration.mac.signIgnore
      : [baseConfiguration.mac.signIgnore]
    : []
  return credentialBackendMetadataConfiguration(
    {
      ...baseConfiguration,
      extraResources: [
        ...existingExtraResources,
        {
          from: resolve(credentialBroker.artifactPath),
          to: join('credential-broker', 'credential-broker'),
        },
      ],
      mac: {
        ...baseConfiguration.mac,
        signIgnore: [
          ...existingSignIgnore,
          String.raw`[/\\]Contents[/\\]Resources[/\\]credential-broker[/\\]credential-broker$`,
        ],
        timestamp: 'none',
      },
    },
    {
      architecture: credentialBroker.architecture,
      cdHash: credentialBroker.cdHash,
      executableSha256: credentialBroker.executableSha256,
      identifier: credentialBroker.identifier,
      keyId: credentialBroker.keyId,
      kind: 'macos-credential-broker-v1',
      protocolVersion: credentialBroker.protocolVersion,
      sourceDigest: credentialBroker.sourceDigest,
    },
  )
}

export function parseCodeSigningDetails(output) {
  const details = new Map()
  for (const line of output.split(/\r?\n/u)) {
    const separator = line.indexOf('=')
    if (separator > 0) {
      const key = line.slice(0, separator).trim()
      const value = line.slice(separator + 1).trim()
      const values = details.get(key) ?? []
      values.push(value)
      details.set(key, values)
    }
  }
  return details
}

export function verifyCredentialBrokerArtifact(
  artifactPath,
  metadata,
  expectedCertificateSha1,
  expectedEvidence,
) {
  const resolvedArtifactPath = resolve(artifactPath)
  const fileStat = lstatSync(resolvedArtifactPath)
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error(`Credential broker is not a regular file: ${resolvedArtifactPath}`)
  }
  runCommand('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', resolvedArtifactPath])
  const detailsOutput = runCommand('/usr/bin/codesign', [
    '--display',
    '--verbose=4',
    resolvedArtifactPath,
  ])
  const details = parseCodeSigningDetails(detailsOutput)
  const identifier = details.get('Identifier')?.[0]
  const cdHash = details.get('CDHash')?.[0]?.toLowerCase()
  const authorities = details.get('Authority') ?? []
  const expectedIdentifier = `${metadata.appId}.credential-broker`
  if (identifier !== expectedIdentifier || !cdHash || authorities.length === 0) {
    throw new Error('Credential broker signature identity is invalid.')
  }
  const certificateSha1 = signerCertificateSha1(resolvedArtifactPath)
  if (
    present(expectedCertificateSha1) &&
    certificateSha1 !== normalizeFingerprint(expectedCertificateSha1)
  ) {
    throw new Error('Credential broker was not signed by the configured local identity.')
  }
  const executableSha256 = sha256File(resolvedArtifactPath)
  if (expectedEvidence) {
    if (
      expectedEvidence.identifier !== identifier ||
      expectedEvidence.cdHash.toLowerCase() !== cdHash ||
      expectedEvidence.executableSha256.toLowerCase() !== executableSha256
    ) {
      throw new Error(
        'Credential broker changed without an explicit signing setup rotation. Run "pnpm signing:setup:mac -- --replace-broker".',
      )
    }
  }
  return {
    appPath: resolvedArtifactPath,
    cdHash,
    certificateSha1,
    executableSha256,
    identifier,
  }
}

export function assertStableSignatureEvidence({
  appId,
  detailsOutput,
  designatedRequirementOutput,
}) {
  const details = parseCodeSigningDetails(detailsOutput)
  const identifier = details.get('Identifier')?.[0]
  const signature = details.get('Signature')?.[0]
  const authorities = details.get('Authority') ?? []
  const requirement = designatedRequirementOutput
    .split(/\r?\n/u)
    .find((line) => line.trim().startsWith('designated =>'))
    ?.trim()

  if (identifier !== appId) {
    throw new Error(`Signed bundle identifier is ${String(identifier)}, expected ${appId}.`)
  }
  if (signature?.toLowerCase() === 'adhoc' || authorities.length === 0) {
    throw new Error('The application has an ad-hoc or certificate-less signature.')
  }
  if (!requirement) {
    throw new Error('The application has no designated code requirement.')
  }
  if (/^designated\s*=>\s*cdhash\b/iu.test(requirement)) {
    throw new Error('The designated requirement is tied only to a changing code hash.')
  }
  if (!requirement.includes(`identifier "${appId}"`)) {
    throw new Error('The designated requirement is not bound to the application identifier.')
  }
  if (!/\b(?:anchor|certificate)\b/iu.test(requirement)) {
    throw new Error('The designated requirement is not bound to a signing certificate trust rule.')
  }

  return { authorities, identifier, requirement }
}

function signerCertificateSha1(appPath) {
  const extractionDirectory = mkdtempSync(join(tmpdir(), 'code-assistant-signature-'))
  try {
    const prefix = join(extractionDirectory, 'certificate')
    runCommand('/usr/bin/codesign', ['--display', `--extract-certificates=${prefix}`, appPath])
    const output = runCommand('/usr/bin/openssl', [
      'x509',
      '-inform',
      'DER',
      '-in',
      `${prefix}0`,
      '-noout',
      '-fingerprint',
      '-sha1',
    ])
    const match = output.match(/Fingerprint=([0-9A-F:]{59})/iu)
    if (!match) {
      throw new Error('Unable to read the leaf signing certificate fingerprint.')
    }
    return normalizeFingerprint(match[1])
  } finally {
    rmSync(extractionDirectory, { force: true, recursive: true })
  }
}

export function verifyMacAppSignature(appPath, metadata, expectedCertificateSha1) {
  const resolvedAppPath = resolve(appPath)
  runCommand('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    resolvedAppPath,
  ])
  const detailsOutput = runCommand('/usr/bin/codesign', [
    '--display',
    '--verbose=4',
    resolvedAppPath,
  ])
  const requirementOutput = runCommand('/usr/bin/codesign', [
    '--display',
    '--requirements',
    '-',
    resolvedAppPath,
  ])
  const evidence = assertStableSignatureEvidence({
    appId: metadata.appId,
    designatedRequirementOutput: requirementOutput,
    detailsOutput,
  })
  const certificateSha1 = signerCertificateSha1(resolvedAppPath)

  if (
    present(expectedCertificateSha1) &&
    certificateSha1 !== normalizeFingerprint(expectedCertificateSha1)
  ) {
    throw new Error('The packaged application was not signed by the configured local identity.')
  }

  return { ...evidence, appPath: resolvedAppPath, certificateSha1 }
}

function findNamedAppBundles(directory, expectedName, depth, result) {
  if (depth < 0) {
    return
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue
    }
    const entryPath = join(directory, entry.name)
    if (entry.name.endsWith('.app')) {
      if (entry.name === expectedName) {
        result.push(entryPath)
      }
      continue
    }
    findNamedAppBundles(entryPath, expectedName, depth - 1, result)
  }
}

export function findMacAppBundles(metadata) {
  const candidates = []
  try {
    findNamedAppBundles(metadata.outputDirectory, `${metadata.productName}.app`, 3, candidates)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return candidates
}

export function findRunningMacBundleProcesses(processListing, appPaths, executableName) {
  const executablePaths = new Map(
    appPaths.map((appPath) => [
      resolve(appPath, 'Contents', 'MacOS', executableName),
      resolve(appPath),
    ]),
  )
  const running = []
  for (const line of processListing.split(/\r?\n/u)) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/u)
    if (!match) continue
    const pid = Number(match[1])
    const command = match[2]
    for (const [executablePath, appPath] of executablePaths) {
      if (command === executablePath || command.startsWith(`${executablePath} `)) {
        running.push({ appPath, pid })
        break
      }
    }
  }
  return running
}

export function findFreshMacAppBundles(metadata, builtAfter) {
  const candidates = findMacAppBundles(metadata)
  return candidates.filter((appPath) => {
    try {
      const signatureResources = join(appPath, 'Contents', '_CodeSignature', 'CodeResources')
      return statSync(signatureResources).mtimeMs >= builtAfter - 2_000
    } catch {
      return false
    }
  })
}
