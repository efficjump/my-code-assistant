import CryptoKit
import Foundation
import Security

enum KeychainMasterKeyStore {
  static func loadOrCreate() throws -> SymmetricKey {
    if var existing = try load() {
      defer { existing.resetBytes(in: 0..<existing.count) }
      return SymmetricKey(data: existing)
    }

    var keyBytes = Data(count: 32)
    defer { keyBytes.resetBytes(in: 0..<keyBytes.count) }
    let status = keyBytes.withUnsafeMutableBytes { buffer in
      SecRandomCopyBytes(kSecRandomDefault, buffer.count, buffer.baseAddress!)
    }
    guard status == errSecSuccess else { throw BrokerFailure.keychainUnavailable }

    var access: SecAccess?
    guard
      SecAccessCreate(
        BrokerBuildIdentity.keychainDescriptor as CFString,
        nil,
        &access
      ) == errSecSuccess,
      let access
    else {
      throw BrokerFailure.keychainUnavailable
    }

    let attributes: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: BrokerBuildIdentity.keychainService,
      kSecAttrAccount: BrokerBuildIdentity.keychainAccount,
      kSecAttrSynchronizable: false,
      kSecAttrAccess: access,
      kSecValueData: keyBytes,
      kSecUseAuthenticationUI: kSecUseAuthenticationUIFail,
    ]
    let addStatus = SecItemAdd(attributes as CFDictionary, nil)
    if addStatus == errSecSuccess {
      return SymmetricKey(data: keyBytes)
    }
    if addStatus == errSecDuplicateItem, var raced = try load() {
      defer { raced.resetBytes(in: 0..<raced.count) }
      return SymmetricKey(data: raced)
    }
    throw BrokerFailure.keychainUnavailable
  }

  private static func load() throws -> Data? {
    let query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: BrokerBuildIdentity.keychainService,
      kSecAttrAccount: BrokerBuildIdentity.keychainAccount,
      kSecAttrSynchronizable: false,
      kSecReturnData: true,
      kSecMatchLimit: kSecMatchLimitOne,
      kSecUseAuthenticationUI: kSecUseAuthenticationUIFail,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess,
      let data = result as? Data,
      data.count == 32
    else {
      throw BrokerFailure.keychainUnavailable
    }
    return data
  }
}
