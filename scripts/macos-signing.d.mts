export interface ProjectMetadata {
  appId: string
  outputDirectory: string
  packageName: string
  productName: string
}

export interface SigningIdentity {
  fingerprint: string
  name: string
}

export interface BuilderResource {
  from: string
  to: string
}

export interface MacBuilderConfiguration {
  signIgnore?: string | string[]
  timestamp?: string
  [key: string]: unknown
}

export interface BuilderConfiguration {
  extraResources?: BuilderResource | BuilderResource[]
  extraMetadata?: Record<string, unknown>
  mac?: MacBuilderConfiguration
  [key: string]: unknown
}

export interface CredentialBrokerBuildEvidence {
  architecture: 'arm64' | 'x64'
  artifactPath: string
  cdHash: string
  executableSha256: string
  identifier: string
  keyId: string
  protocolVersion: number
  sourceDigest: string
}

export const LOCAL_SIGNING_CONFIG_VERSION: number
export function normalizeFingerprint(value: string): string
export function parseIdentityListing(output: string): SigningIdentity[]
export function identityMatches(identity: SigningIdentity, qualifier: string): boolean
export function selectUniqueIdentity(
  identities: SigningIdentity[],
  qualifier: string,
): SigningIdentity
export function electronBuilderArguments(
  signingSource: 'local-keychain' | 'external-keychain' | 'external-certificate',
): string[]
export function localCredentialBrokerBuildConfiguration(
  baseConfiguration: BuilderConfiguration,
  credentialBroker: CredentialBrokerBuildEvidence,
): BuilderConfiguration & {
  extraResources: BuilderResource[]
  mac: MacBuilderConfiguration & { signIgnore: string[]; timestamp: 'none' }
}
export function safeStorageBuildConfiguration(
  baseConfiguration: BuilderConfiguration,
): BuilderConfiguration & { extraMetadata: Record<string, unknown> }
export function parseCodeSigningDetails(output: string): Map<string, string[]>
export function assertStableSignatureEvidence(input: {
  appId: string
  detailsOutput: string
  designatedRequirementOutput: string
}): { authorities: string[]; identifier: string; requirement: string }
export function findMacAppBundles(metadata: ProjectMetadata): string[]
export function findRunningMacBundleProcesses(
  processListing: string,
  appPaths: string[],
  executableName: string,
): Array<{ appPath: string; pid: number }>
