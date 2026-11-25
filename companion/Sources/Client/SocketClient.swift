import Foundation
import Network

protocol StatusClient: Sendable {
    func status() async throws -> EngineStatus
}

protocol ReposClient: Sendable {
    func reposStatus() async throws -> ReposStatusResponse
    func reposPull(repo: String) async throws -> RepoPullResponse
}

protocol ApprovalsClient: Sendable {
    func approvalsList(status: String?) async throws -> ApprovalsListResponse
    func approvalsAccept(id: String) async throws -> ApprovalDecisionResponse
    func approvalsReject(id: String) async throws -> ApprovalDecisionResponse
}

enum SocketClientError: LocalizedError, Equatable {
    case invalidResponse
    case engineUnavailable
    case remoteError(code: String, message: String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse: "Duck received an invalid response from ctx."
        case .engineUnavailable: "The ctx engine is not running."
        case .remoteError(_, let message): message
        }
    }
}

struct UnixSocketClient: StatusClient, ReposClient, ApprovalsClient {
    let socketPath: String

    init(socketPath: String = ("~/.ctx/ctx.sock" as NSString).expandingTildeInPath) {
        self.socketPath = socketPath
    }

    func status() async throws -> EngineStatus {
        try await send(method: "status", params: EmptyParams())
    }

    func reposStatus() async throws -> ReposStatusResponse {
        try await send(method: "repos.status", params: EmptyParams())
    }

    func reposPull(repo: String) async throws -> RepoPullResponse {
        try await send(method: "repos.pull", params: PullParams(repo: repo))
    }

    func approvalsList(status: String? = "pending") async throws -> ApprovalsListResponse {
        try await send(method: "approvals.list", params: ApprovalsListParams(status: status))
    }

    func approvalsAccept(id: String) async throws -> ApprovalDecisionResponse {
        try await send(method: "approvals.accept", params: ApprovalIdParams(id: id))
    }

    func approvalsReject(id: String) async throws -> ApprovalDecisionResponse {
        try await send(method: "approvals.reject", params: ApprovalIdParams(id: id))
    }

    private func send<P: Encodable, R: Decodable & Sendable>(method: String, params: P) async throws -> R {
        let envelope = SocketRequest(v: 1, id: UUID().uuidString, method: method, params: params)
        guard let encoded = try? JSONEncoder().encode(envelope),
              var payload = String(data: encoded, encoding: .utf8) else {
            throw SocketClientError.invalidResponse
        }
        payload.append("\n")

        let queue = DispatchQueue(label: "ctx.socket.client.\(UUID().uuidString)")
        let connection = NWConnection(to: .unix(path: socketPath), using: .tcp)
        return try await withCheckedThrowingContinuation { continuation in
            let gate = CompletionGate<R>(continuation)
            let bufferBox = ReceiveBuffer()
            connection.stateUpdateHandler = { state in
                if case .failed = state {
                    gate.fail(SocketClientError.engineUnavailable)
                    connection.cancel()
                }
            }
            connection.start(queue: queue)

            @Sendable func decodeAndFinish(_ lineData: Data) {
                defer { connection.cancel() }
                guard let response = try? JSONDecoder.ctx.decode(SocketResponse<R>.self, from: lineData) else {
                    gate.fail(SocketClientError.invalidResponse)
                    return
                }
                if response.ok, let result = response.result {
                    gate.succeed(result)
                } else if let err = response.error {
                    gate.fail(SocketClientError.remoteError(code: err.code, message: err.message))
                } else {
                    gate.fail(SocketClientError.invalidResponse)
                }
            }

            @Sendable func receiveNext() {
                connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { data, _, isComplete, error in
                    if error != nil {
                        gate.fail(SocketClientError.engineUnavailable)
                        connection.cancel()
                        return
                    }
                    if let data, !data.isEmpty {
                        bufferBox.append(data)
                    }
                    if let lineData = bufferBox.takeLine() {
                        decodeAndFinish(lineData)
                        return
                    }
                    if isComplete {
                        gate.fail(SocketClientError.invalidResponse)
                        connection.cancel()
                        return
                    }
                    receiveNext()
                }
            }

            connection.send(content: payload.data(using: .utf8), completion: .contentProcessed { error in
                if error != nil {
                    gate.fail(SocketClientError.engineUnavailable)
                    connection.cancel()
                    return
                }
                receiveNext()
            })
        }
    }
}

private struct EmptyParams: Encodable {}
private struct PullParams: Encodable { let repo: String }
private struct ApprovalsListParams: Encodable { let status: String? }
private struct ApprovalIdParams: Encodable { let id: String }

private struct SocketRequest<P: Encodable>: Encodable {
    let v: Int
    let id: String
    let method: String
    let params: P
}

private struct SocketErrorBody: Decodable {
    let code: String
    let message: String
}

private struct SocketResponse<R: Decodable>: Decodable {
    let v: Int
    let ok: Bool
    let result: R?
    let error: SocketErrorBody?
}

private final class ReceiveBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()

    func append(_ chunk: Data) {
        lock.lock(); defer { lock.unlock() }
        data.append(chunk)
    }

    func takeLine() -> Data? {
        lock.lock(); defer { lock.unlock() }
        guard let newlineIndex = data.firstIndex(of: UInt8(ascii: "\n")) else { return nil }
        return Data(data[..<newlineIndex])
    }
}

private final class CompletionGate<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var completed = false
    private let continuation: CheckedContinuation<T, Error>

    init(_ continuation: CheckedContinuation<T, Error>) { self.continuation = continuation }
    func succeed(_ value: T) { finish { continuation.resume(returning: value) } }
    func fail(_ error: Error) { finish { continuation.resume(throwing: error) } }
    private func finish(_ action: () -> Void) {
        lock.lock(); defer { lock.unlock() }
        guard !completed else { return }
        completed = true; action()
    }
}

private extension JSONDecoder {
    static let ctx: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601WithFractionalSeconds
        return decoder
    }()
}

private extension JSONDecoder.DateDecodingStrategy {
    static let iso8601WithFractionalSeconds = custom { decoder in
        let container = try decoder.singleValueContainer()
        let raw = try container.decode(String.self)
        let withFrac = ISO8601DateFormatter()
        withFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFrac.date(from: raw) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let date = plain.date(from: raw) { return date }
        throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid ISO8601 date: \(raw)")
    }
}
