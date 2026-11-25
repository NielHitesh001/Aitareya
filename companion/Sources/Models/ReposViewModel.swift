import Foundation

enum PillStatusColor: Equatable, Sendable {
    case green
    case amber
    case red
}

@MainActor
final class ReposViewModel: ObservableObject {
    @Published private(set) var status: ReposStatusResponse?
    @Published private(set) var isOffline = false
    @Published private(set) var isRefreshing = false
    @Published private(set) var pullingRepo: String?
    @Published private(set) var errorMessage: String?
    @Published var isExpanded = false
    @Published var pendingPullRepo: RepoItem?

    private let client: any ReposClient
    private var pollTask: Task<Void, Never>?

    init(client: any ReposClient = UnixSocketClient()) {
        self.client = client
    }

    var repos: [RepoItem] {
        status?.repos ?? []
    }

    var counts: RepoCounts {
        status?.counts ?? .zero
    }

    var lastSuccessfulPoll: Date? {
        status?.lastSuccessfulPoll
    }

    var collapsedLabel: String {
        let count = repos.count
        return "\(count) \(count == 1 ? "repo" : "repos")"
    }

    var pillColor: PillStatusColor {
        if isOffline || errorMessage != nil || counts.diverged > 0 {
            return .red
        }
        if counts.behind > 0 || counts.dirty > 0 || counts.ahead > 0 || counts.missing > 0 {
            return .amber
        }
        return .green
    }

    func badgeText(for repo: RepoItem) -> String {
        switch repo.state {
        case .upToDate: "Up to date"
        case .behind: "Behind \(repo.behind)"
        case .ahead: "Ahead \(repo.ahead)"
        case .diverged: "Diverged"
        case .dirty: "Dirty"
        case .missing: "Missing"
        }
    }

    func canPull(_ repo: RepoItem) -> Bool {
        !isOffline && pullingRepo == nil && repo.state == .behind && !repo.dirty
    }

    func setExpanded(_ expanded: Bool) {
        isExpanded = expanded
        pollTask?.cancel()
        pollTask = nil
        if expanded {
            pollTask = Task { [weak self] in
                await self?.refresh()
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(15))
                    if Task.isCancelled { break }
                    await self?.refresh()
                }
            }
        }
    }

    func refresh() async {
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            status = try await client.reposStatus()
            isOffline = false
            errorMessage = nil
        } catch SocketClientError.engineUnavailable {
            isOffline = true
            errorMessage = "Engine not running"
        } catch {
            isOffline = false
            errorMessage = error.localizedDescription
        }
    }

    func requestPull(_ repo: RepoItem) {
        guard canPull(repo) else { return }
        pendingPullRepo = repo
    }

    func cancelPull() {
        pendingPullRepo = nil
    }

    func confirmPull() async {
        guard let repo = pendingPullRepo else { return }
        pendingPullRepo = nil
        pullingRepo = repo.name
        defer { pullingRepo = nil }
        do {
            _ = try await client.reposPull(repo: repo.name)
            errorMessage = nil
            await refresh()
        } catch SocketClientError.engineUnavailable {
            isOffline = true
            errorMessage = "Engine not running"
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
