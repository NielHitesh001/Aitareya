import Foundation

enum RepoState: String, Codable, Equatable, Sendable {
    case upToDate
    case behind
    case ahead
    case diverged
    case dirty
    case missing
}

struct RepoItem: Codable, Equatable, Identifiable, Sendable {
    var id: String { name }
    let name: String
    let path: String?
    let branch: String
    let state: RepoState
    let ahead: Int
    let behind: Int
    let dirty: Bool
    let lastFetch: Date?
    let prState: String

    var prURL: URL? {
        guard prState.hasPrefix("https://") || prState.hasPrefix("http://") else { return nil }
        return URL(string: prState)
    }
}

struct RepoCounts: Codable, Equatable, Sendable {
    let upToDate: Int
    let behind: Int
    let ahead: Int
    let diverged: Int
    let dirty: Int
    let missing: Int

    static let zero = RepoCounts(upToDate: 0, behind: 0, ahead: 0, diverged: 0, dirty: 0, missing: 0)
}

struct ReposStatusResponse: Codable, Equatable, Sendable {
    let repos: [RepoItem]
    let counts: RepoCounts
    let lastSuccessfulPoll: Date?
}

struct RepoPullResponse: Codable, Equatable, Sendable {
    let repo: String
    let status: String
    let line: String
}
