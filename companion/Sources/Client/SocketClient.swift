import Foundation
import Network

protocol StatusClient: Sendable {
    func status() async throws -> EngineStatus
}

enum SocketClientError: LocalizedError {
    case invalidResponse
    case engineUnavailable

    var errorDescription: String? {
        switch self {
        case .invalidResponse: "Duck received an invalid response from ctx."
        case .engineUnavailable: "The ctx engine is not running."
        }
    }
}

struct UnixSocketClient: StatusClient {
    let socketPath: String

    init(socketPath: String = ("~/.ctx/ctx.sock" as NSString).expandingTildeInPath) {
        self.socketPath = socketPath
    }

    func status() async throws -> EngineStatus {
        let request = #"{"v":1,"id":"\#(UUID().uuidString)","method":"status"}"# + "\n"
        let connection = NWConnection(to: .unix(path: socketPath), using: .tcp)
        return try await withCheckedThrowingContinuation { continuation in
            let gate = CompletionGate(continuation)
            connection.stateUpdateHandler = { state in
                if case .failed = state { gate.fail(SocketClientError.engineUnavailable); connection.cancel() }
            }
            connection.start(queue: .global(qos: .userInitiated))
            connection.send(content: request.data(using: .utf8), completion: .contentProcessed { error in
                if error != nil { gate.fail(SocketClientError.engineUnavailable); connection.cancel(); return }
                connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { data, _, _, error in
                    defer { connection.cancel() }
                    guard error == nil, let data, let line = String(data: data, encoding: .utf8)?.split(separator: "\n").first,
                          let response = try? JSONDecoder.ctx.decode(SocketResponse.self, from: Data(line.utf8)),
                          response.ok, let result = response.result else {
                        gate.fail(SocketClientError.invalidResponse)
                        return
                    }
                    gate.succeed(result)
                }
            })
        }
    }
}

private struct SocketResponse: Decodable {
    let v: Int
    let ok: Bool
    let result: EngineStatus?
}

private final class CompletionGate: @unchecked Sendable {
    private let lock = NSLock()
    private var completed = false
    private let continuation: CheckedContinuation<EngineStatus, Error>

    init(_ continuation: CheckedContinuation<EngineStatus, Error>) { self.continuation = continuation }
    func succeed(_ value: EngineStatus) { finish { continuation.resume(returning: value) } }
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
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}
