# Stable macOS code signing and credential broker

An ad-hoc signature is based on a code hash, so its identity changes whenever the application is
rebuilt. A self-signed Electron application can still repeatedly prompt after it receives a stable
certificate-bound designated requirement: macOS Keychain's application-partition enforcement may
also bind access to changing code-hash evidence. Selecting **Always Allow** for the outer Electron
executable is therefore not a durable fix for local rebuilds.

This project refuses unsigned or ad-hoc macOS packages. Local self-signed packages additionally use
a small, pre-signed native credential broker. The broker binary is copied byte-for-byte into every
build, so its CDHash remains stable while the outer Electron application changes. Before touching
Keychain, the broker verifies that its direct parent is the exact current outer application, that
the complete application signature is valid, and that the broker and parent have the same leaf
certificate. The broker then protects provider credentials with AES-GCM and a Keychain-held master
key. Keychain operations are configured to fail instead of presenting authentication UI.

The packaged `app.asar` metadata explicitly selects either the broker or Electron Safe Storage.
Local packages record the broker key ID, protocol, SHA-256, CDHash, identifier, architecture, and
source digest. The main process validates that signed metadata and rechecks the executable hash and
code-signing evidence before sending credential bytes. A local package with missing metadata,
missing broker, a non-executable broker, or a failed probe does not silently fall back to Safe
Storage. External packages carry an explicit Safe Storage marker instead.

## Signing source selection

`pnpm package` resolves the signer at build time in this order:

1. External electron-builder credentials (`CSC_LINK`, optionally `CSC_KEY_PASSWORD` and
   `CSC_NAME`). This is the production/CI path.
2. An existing external Keychain identity selected by `CSC_NAME` and optionally `CSC_KEYCHAIN`.
3. The project-specific local identity and credential broker configured by
   `pnpm signing:setup:mac`.

No certificate name, password, private key, or user-specific path is committed to the repository.
The package command enables `forceCodeSigning` and verifies the resulting app with `codesign`.
Verification rejects an ad-hoc signature, a changed bundle identifier, a `cdhash`-only designated
requirement, and a package signed by a different local identity. For local packages it also rejects
a stale or modified broker source/artifact, copies the recorded pre-signed artifact as an extra
resource without re-signing it, and verifies its identifier, certificate, executable SHA-256, and
CDHash after packaging.

## One-time local setup

Run this on the Mac that builds and runs the local application:

```bash
pnpm signing:setup:mac
pnpm package
```

The setup command creates a self-signed code-signing certificate and imports its private key into
the current user's default Keychain. The private key is marked non-extractable and grants access
only to `/usr/bin/codesign`; the script never uses `security import -A`. It also compiles and signs
the fixed Swift broker. Version 3 of the local configuration records broker protocol version 2,
architecture, source digest, artifact path, executable SHA-256, identifier, CDHash, and a random
128-bit key ID in addition to the signing identity evidence. That key ID namespaces the broker's
Keychain service/account and is embedded in every broker ciphertext marker. The configuration is
written with mode `0600`, and the broker artifact with private directory/file permissions, below the
user's `~/Library/Application Support` directory. Neither file contains a private key or credential.

The local certificate is for repeatable development builds only. It does not replace an Apple
Developer ID certificate, notarization, or Gatekeeper-compatible distribution signing.
Local self-signed packages explicitly disable network timestamping because Apple's timestamp
service may reject non-Apple identities. External production identities retain electron-builder's
normal secure timestamp behavior.

On the first launch after upgrading, existing credentials may still be encrypted by Electron Safe
Storage. After the application window and IPC handlers are ready—but before renderer model
requests are released—the application visits the active provider first, followed by inactive
providers only until the first failure. Each successful provider is immediately checkpointed with
a generation/ciphertext compare-and-swap, without advancing its provider generation. If the legacy
Safe Storage item unlocks and no later credential fails, one successful Keychain approval can be
enough to migrate every readable value in that pass. A damaged or denied credential is preserved
and reported without rolling back earlier checkpoints, and that exact provider/ciphertext pair is
not retried in the same process. Because Electron cannot reliably distinguish a denial from
corruption, automatic scanning stops at that first failure to avoid a SecurityAgent prompt storm.
Later providers remain intact and can migrate when the user explicitly accesses them. New and
successfully migrated credentials no longer use the changing outer executable's Safe Storage item,
so ordinary rebuilds do not present that prompt again.

Apple Developer ID/Apple-team-signed packages keep the normal Electron Safe Storage path and
timestamp behavior. The local broker path is selected only for the self-signed development package;
it is not a replacement for notarization or production distribution signing.

Use `--replace` only when rotating an expired, lost, or intentionally revoked local identity:

```bash
pnpm signing:setup:mac -- --replace
```

Replacing the identity also rebuilds the broker with a new random key ID and a separate artifact
cache path. Existing broker ciphertext remains untouched but is deliberately reported as requiring
API-key re-entry. Entering a replacement API key writes it under the new namespace; an inaccessible
old Keychain item cannot block new credential saves.

Broker source changes are also explicit. Setup and packaging refuse to use a broker whose current
source digest differs from the recorded artifact. Review the native change and rotate only the
broker with:

```bash
pnpm signing:setup:mac -- --replace-broker
```

Ordinary application builds must not use this option: retaining the pre-signed broker artifact,
key ID, and CDHash is what avoids repeated Keychain prompts. A deliberate broker rotation generates
a new key ID and Keychain namespace. Old ciphertext is preserved and fails with a re-entry-required
error, while newly entered credentials save normally. The cache path includes the certificate
fingerprint and key ID, so a failed rotation cannot overwrite the artifact referenced by the last
durable configuration.

## Local threat boundary

The local certificate and broker prevent accidental unsigned substitution and stop a different
ordinary executable from directly reading the broker's Keychain item. They are not an isolation
boundary against arbitrary code already running as the same macOS user. In particular, the local
private key authorizes `/usr/bin/codesign` so repeated packaging does not prompt; a trusted
workspace command with the same-user privileges can invoke that signer, read application settings,
and create a same-certificate clone that satisfies the local signature checks. The signed backend
metadata and runtime SHA/CDHash checks prevent post-package broker replacement, but cannot
distinguish such an intentionally forged same-user build from a legitimate local rebuild.

Do not approve or auto-run untrusted workspace commands. A stronger boundary requires an Apple-team
identity with App Sandbox/Keychain access groups, or a separately isolated manifest signer with a
new user-approval or hardware-backed trust ceremony. Those distribution/security models are outside
the no-prompt self-signed development workflow.

## Verification

The package command verifies every freshly produced application automatically. A packaged app can
also be checked explicitly:

```bash
pnpm signing:verify:mac -- "/absolute/path/to/Code Assistant.app"
```

The `--` delimiter forwards the application path to the verification script rather than treating it
as a `pnpm` option.

For a local package the standalone command also recomputes the current source digest and validates
the packaged broker against the configured identifier, certificate, executable SHA-256, and CDHash.
It prints the broker CDHash/key ID plus the outer leaf certificate and designated requirement. The
broker evidence must remain fixed across ordinary rebuilds even while the outer executable hash
changes.
