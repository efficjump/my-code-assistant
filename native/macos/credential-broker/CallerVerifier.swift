import Foundation
import Security

struct VerifiedCaller {
  let isAppleTeamSigned: Bool
}

enum CallerVerifier {
  static func verifyDirectParent() throws -> VerifiedCaller {
    let parentPID = getppid()
    guard parentPID > 1 else { throw BrokerFailure.callerRejected }

    let brokerURL = try canonicalURL(URL(fileURLWithPath: CommandLine.arguments[0]))
    let appURL = try containingApplicationURL(for: brokerURL)
    guard let bundle = Bundle(url: appURL),
      bundle.bundleIdentifier == BrokerBuildIdentity.parentBundleIdentifier,
      let expectedExecutable = bundle.executableURL
    else {
      throw BrokerFailure.callerRejected
    }

    var staticCode: SecStaticCode?
    guard SecStaticCodeCreateWithPath(appURL as CFURL, [], &staticCode) == errSecSuccess,
      let staticCode
    else {
      throw BrokerFailure.callerRejected
    }
    let staticFlags = SecCSFlags(
      rawValue:
        kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode
    )
    guard SecStaticCodeCheckValidity(staticCode, staticFlags, nil) == errSecSuccess else {
      throw BrokerFailure.callerRejected
    }

    var parentCode: SecCode?
    let attributes = [kSecGuestAttributePid: NSNumber(value: parentPID)] as CFDictionary
    guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &parentCode) == errSecSuccess,
      let parentCode
    else {
      throw BrokerFailure.callerRejected
    }
    let parentStaticCode = try copyStaticCode(for: parentCode)

    let expectedPath = try canonicalURL(expectedExecutable)
    let parentInformation = try signingInformation(parentStaticCode)
    guard let parentExecutable = parentInformation[kSecCodeInfoMainExecutable] as? URL,
      try canonicalURL(parentExecutable) == expectedPath,
      parentInformation[kSecCodeInfoIdentifier] as? String
        == BrokerBuildIdentity.parentBundleIdentifier
    else {
      throw BrokerFailure.callerRejected
    }

    let staticInformation = try signingInformation(staticCode)
    guard let codeHash = staticInformation[kSecCodeInfoUnique] as? Data,
      !codeHash.isEmpty
    else {
      throw BrokerFailure.callerRejected
    }
    var designatedRequirement: SecRequirement?
    var designatedTextValue: CFString?
    guard SecCodeCopyDesignatedRequirement(staticCode, [], &designatedRequirement) == errSecSuccess,
      let designatedRequirement,
      SecRequirementCopyString(designatedRequirement, [], &designatedTextValue)
        == errSecSuccess,
      let designatedText = designatedTextValue as String?
    else {
      throw BrokerFailure.callerRejected
    }

    let exactRequirementText =
      "(\(designatedText)) and cdhash H\"\(codeHash.hexadecimal)\""
    var exactRequirement: SecRequirement?
    guard
      SecRequirementCreateWithString(
        exactRequirementText as CFString,
        [],
        &exactRequirement
      ) == errSecSuccess,
      let exactRequirement,
      SecCodeCheckValidity(parentCode, SecCSFlags(rawValue: kSecCSStrictValidate), exactRequirement)
        == errSecSuccess
    else {
      throw BrokerFailure.callerRejected
    }

    var selfCode: SecCode?
    guard SecCodeCopySelf([], &selfCode) == errSecSuccess, let selfCode else {
      throw BrokerFailure.callerRejected
    }
    let selfInformation = try signingInformation(try copyStaticCode(for: selfCode))
    guard
      selfInformation[kSecCodeInfoIdentifier] as? String == BrokerBuildIdentity.brokerIdentifier,
      leafCertificateData(selfInformation) == leafCertificateData(parentInformation)
    else {
      throw BrokerFailure.callerRejected
    }

    return VerifiedCaller(isAppleTeamSigned: isAppleTeamSigned(parentCode, parentInformation))
  }

  private static func copyStaticCode(for code: SecCode) throws -> SecStaticCode {
    var result: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &result) == errSecSuccess, let result else {
      throw BrokerFailure.callerRejected
    }
    return result
  }

  private static func signingInformation(_ code: SecStaticCode) throws -> [CFString: Any] {
    var information: CFDictionary?
    let flags = SecCSFlags(rawValue: kSecCSSigningInformation | kSecCSRequirementInformation)
    guard SecCodeCopySigningInformation(code, flags, &information) == errSecSuccess,
      let result = information as? [CFString: Any]
    else {
      throw BrokerFailure.callerRejected
    }
    return result
  }

  private static func leafCertificateData(_ information: [CFString: Any]) -> Data? {
    guard let certificates = information[kSecCodeInfoCertificates] as? [SecCertificate],
      let leaf = certificates.first
    else { return nil }
    return SecCertificateCopyData(leaf) as Data
  }

  private static func isAppleTeamSigned(
    _ code: SecCode,
    _ information: [CFString: Any]
  ) -> Bool {
    guard let team = information[kSecCodeInfoTeamIdentifier] as? String,
      team.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil
    else {
      return false
    }
    let source = "anchor apple generic and certificate leaf[subject.OU] = \"\(team)\""
    var requirement: SecRequirement?
    guard SecRequirementCreateWithString(source as CFString, [], &requirement) == errSecSuccess,
      let requirement
    else { return false }
    return SecCodeCheckValidity(code, [], requirement) == errSecSuccess
  }

  private static func containingApplicationURL(for executable: URL) throws -> URL {
    var candidate = executable.deletingLastPathComponent()
    while candidate.path != "/" {
      if candidate.pathExtension == "app" { return try canonicalURL(candidate) }
      candidate.deleteLastPathComponent()
    }
    throw BrokerFailure.callerRejected
  }

  private static func canonicalURL(_ url: URL) throws -> URL {
    let path = url.path
    guard let resolved = realpath(path, nil) else { throw BrokerFailure.callerRejected }
    defer { free(resolved) }
    return URL(fileURLWithPath: String(cString: resolved)).standardizedFileURL
  }
}

extension Data {
  fileprivate var hexadecimal: String { map { String(format: "%02x", $0) }.joined() }
}
