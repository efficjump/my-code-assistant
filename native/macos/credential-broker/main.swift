import Darwin
import Foundation

private func disableCoreDumps() {
  var limit = rlimit(rlim_cur: 0, rlim_max: 0)
  _ = setrlimit(RLIMIT_CORE, &limit)
}

disableCoreDumps()

do {
  // Caller validation intentionally happens before request parsing or any Keychain operation.
  let caller = try CallerVerifier.verifyDirectParent()
  let request = try BrokerRequest.read(from: .standardInput)
  let payload: Data
  switch request.operation {
  case .probe:
    guard request.associatedData.isEmpty, request.payload.isEmpty else {
      throw BrokerFailure.invalidRequest
    }
    payload = try BrokerIdentityPayload.encode(isAppleTeamSigned: caller.isAppleTeamSigned)
  case .encrypt:
    payload = try CredentialCipher.encrypt(
      request.payload,
      associatedData: request.associatedData
    )
  case .decrypt:
    payload = try CredentialCipher.decrypt(
      request.payload,
      associatedData: request.associatedData
    )
  }
  BrokerResponse.write(status: .success, payload: payload, to: .standardOutput)
} catch let failure as BrokerFailure {
  BrokerResponse.write(status: failure.status, to: .standardOutput)
} catch {
  BrokerResponse.write(status: .internalFailure, to: .standardOutput)
}
