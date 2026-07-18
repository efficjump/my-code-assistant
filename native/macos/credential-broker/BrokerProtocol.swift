import Foundation

enum BrokerOperation: UInt8 {
  case probe = 1
  case encrypt = 2
  case decrypt = 3
}

enum BrokerStatus: UInt16 {
  case success = 0
  case callerRejected = 1
  case invalidRequest = 2
  case keychainUnavailable = 3
  case cryptographyFailed = 4
  case internalFailure = 5
}

struct BrokerRequest {
  static let magic = Data([0x4d, 0x43, 0x42, 0x52])  // MCBR
  static let headerLength = 16
  static let maximumAssociatedDataLength = 8_192
  static let maximumPayloadLength = 32_768

  let operation: BrokerOperation
  let associatedData: Data
  let payload: Data

  static func read(from handle: FileHandle) throws -> BrokerRequest {
    let header = try handle.readExactly(count: headerLength)
    guard header.prefix(4) == magic else { throw BrokerFailure.invalidRequest }

    let version = header.readUInt16(at: 4)
    guard version == BrokerBuildIdentity.protocolVersion else {
      throw BrokerFailure.invalidRequest
    }
    guard let operation = BrokerOperation(rawValue: header[6]), header[7] == 0 else {
      throw BrokerFailure.invalidRequest
    }

    let associatedDataLength = Int(header.readUInt32(at: 8))
    let payloadLength = Int(header.readUInt32(at: 12))
    guard associatedDataLength <= maximumAssociatedDataLength,
      payloadLength <= maximumPayloadLength
    else {
      throw BrokerFailure.invalidRequest
    }

    let associatedData = try handle.readExactly(count: associatedDataLength)
    let payload = try handle.readExactly(count: payloadLength)
    if let trailing = try handle.read(upToCount: 1), !trailing.isEmpty {
      throw BrokerFailure.invalidRequest
    }
    return BrokerRequest(
      operation: operation,
      associatedData: associatedData,
      payload: payload
    )
  }
}

enum BrokerResponse {
  static let magic = Data([0x4d, 0x43, 0x42, 0x53])  // MCBS

  static func write(status: BrokerStatus, payload: Data = Data(), to handle: FileHandle) {
    var frame = Data()
    frame.append(magic)
    frame.appendUInt16(BrokerBuildIdentity.protocolVersion)
    frame.appendUInt16(status.rawValue)
    frame.appendUInt32(UInt32(payload.count))
    frame.append(payload)
    do {
      try handle.write(contentsOf: frame)
    } catch {
      // The caller may have exited. Never print protocol or secret material to stderr.
    }
  }
}

enum BrokerIdentityPayload {
  static func encode(isAppleTeamSigned: Bool) throws -> Data {
    let keyIdentifier = Data(BrokerBuildIdentity.keyIdentifier.utf8)
    guard !keyIdentifier.isEmpty, keyIdentifier.count <= 64 else {
      throw BrokerFailure.internalFailure
    }
    var payload = Data([isAppleTeamSigned ? 1 : 0])
    payload.appendUInt16(UInt16(keyIdentifier.count))
    payload.append(keyIdentifier)
    return payload
  }
}

enum BrokerFailure: Error {
  case callerRejected
  case invalidRequest
  case keychainUnavailable
  case cryptographyFailed
  case internalFailure

  var status: BrokerStatus {
    switch self {
    case .callerRejected: return .callerRejected
    case .invalidRequest: return .invalidRequest
    case .keychainUnavailable: return .keychainUnavailable
    case .cryptographyFailed: return .cryptographyFailed
    case .internalFailure: return .internalFailure
    }
  }
}

extension FileHandle {
  fileprivate func readExactly(count: Int) throws -> Data {
    if count == 0 { return Data() }
    var result = Data()
    while result.count < count {
      guard let chunk = try read(upToCount: count - result.count), !chunk.isEmpty else {
        throw BrokerFailure.invalidRequest
      }
      result.append(chunk)
    }
    return result
  }
}

extension Data {
  fileprivate func readUInt16(at offset: Int) -> UInt16 {
    (UInt16(self[offset]) << 8) | UInt16(self[offset + 1])
  }

  fileprivate func readUInt32(at offset: Int) -> UInt32 {
    (UInt32(self[offset]) << 24) | (UInt32(self[offset + 1]) << 16)
      | (UInt32(self[offset + 2]) << 8) | UInt32(self[offset + 3])
  }

  fileprivate mutating func appendUInt16(_ value: UInt16) {
    append(UInt8((value >> 8) & 0xff))
    append(UInt8(value & 0xff))
  }

  fileprivate mutating func appendUInt32(_ value: UInt32) {
    append(UInt8((value >> 24) & 0xff))
    append(UInt8((value >> 16) & 0xff))
    append(UInt8((value >> 8) & 0xff))
    append(UInt8(value & 0xff))
  }
}
