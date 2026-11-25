import Foundation

enum EngineState: String, Codable, Sendable {
    case healthy
    case attention
    case offline
}

struct EngineStatus: Codable, Equatable, Sendable {
    let state: EngineState
    let lastPollAt: Date?
    let allowlistedRepoCount: Int
    let pendingApprovalCount: Int
    let errorCount: Int

    static let offline = EngineStatus(
        state: .offline,
        lastPollAt: nil,
        allowlistedRepoCount: 0,
        pendingApprovalCount: 0,
        errorCount: 0
    )
}
