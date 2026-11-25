import Foundation

struct ApprovalItem: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let projectName: String
    let targetFile: String
    let createdAt: Date
    let diffText: String
    let secretScanKinds: [String]

    var diffPreview: String {
        let lines = diffText
            .split(separator: "\n", omittingEmptySubsequences: true)
            .filter { !$0.hasPrefix("---") && !$0.hasPrefix("+++") && !$0.hasPrefix("@@") }
        return lines.prefix(2).joined(separator: " ")
    }
}

struct ApprovalsListResponse: Codable, Equatable, Sendable {
    let approvals: [ApprovalItem]
}

struct ApprovalDecisionResponse: Codable, Equatable, Sendable {
    let id: String
    let status: String
    let message: String
}
