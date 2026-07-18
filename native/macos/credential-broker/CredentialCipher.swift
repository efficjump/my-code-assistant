import CryptoKit
import Foundation

enum CredentialCipher {
  private static let magic = Data([0x4d, 0x43, 0x42, 0x45])  // MCBE
  private static let envelopeVersion: UInt16 = 1
  private static let envelopeHeaderLength = 6
  private static let maximumPlaintextLength = 16_384

  static func encrypt(_ plaintext: Data, associatedData: Data) throws -> Data {
    guard !plaintext.isEmpty, plaintext.count <= maximumPlaintextLength else {
      throw BrokerFailure.invalidRequest
    }
    do {
      let key = try KeychainMasterKeyStore.loadOrCreate()
      let sealed = try AES.GCM.seal(plaintext, using: key, authenticating: associatedData)
      guard let combined = sealed.combined else { throw BrokerFailure.cryptographyFailed }
      var envelope = Data()
      envelope.append(magic)
      envelope.append(UInt8((envelopeVersion >> 8) & 0xff))
      envelope.append(UInt8(envelopeVersion & 0xff))
      envelope.append(combined)
      return envelope
    } catch let failure as BrokerFailure {
      throw failure
    } catch {
      throw BrokerFailure.cryptographyFailed
    }
  }

  static func decrypt(_ envelope: Data, associatedData: Data) throws -> Data {
    guard envelope.count > envelopeHeaderLength,
      envelope.prefix(4) == magic,
      envelope[4] == UInt8((envelopeVersion >> 8) & 0xff),
      envelope[5] == UInt8(envelopeVersion & 0xff)
    else {
      throw BrokerFailure.invalidRequest
    }
    do {
      let key = try KeychainMasterKeyStore.loadOrCreate()
      let sealed = try AES.GCM.SealedBox(combined: envelope.dropFirst(envelopeHeaderLength))
      let plaintext = try AES.GCM.open(sealed, using: key, authenticating: associatedData)
      guard !plaintext.isEmpty, plaintext.count <= maximumPlaintextLength else {
        throw BrokerFailure.cryptographyFailed
      }
      return plaintext
    } catch let failure as BrokerFailure {
      throw failure
    } catch {
      throw BrokerFailure.cryptographyFailed
    }
  }
}
