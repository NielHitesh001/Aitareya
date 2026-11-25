import XCTest
@testable import CtxCompanion

private final class MockReposClient: ReposClient, @unchecked Sendable {
    var statusResult: Result<ReposStatusResponse, Error>
    var pullResult: Result<RepoPullResponse, Error>
    private(set) var pulledRepos: [String] = []

    init(
        statusResult: Result<ReposStatusResponse, Error>,
        pullResult: Result<RepoPullResponse, Error> = .success(RepoPullResponse(repo: "owner/a", status: "updated", line: "ok"))
    ) {
        self.statusResult = statusResult
        self.pullResult = pullResult
    }

    func reposStatus() async throws -> ReposStatusResponse {
        try statusResult.get()
    }

    func reposPull(repo: String) async throws -> RepoPullResponse {
        pulledRepos.append(repo)
        return try pullResult.get()
    }
}

@MainActor
final class ReposViewModelTests: XCTestCase {
    private func makeRepo(
        name: String,
        state: RepoState,
        ahead: Int = 0,
        behind: Int = 0,
        dirty: Bool = false,
        prState: String = "none"
    ) -> RepoItem {
        RepoItem(
            name: name,
            path: state == .missing ? nil : "/Users/test/code/github/\(name)",
            branch: "main",
            state: state,
            ahead: ahead,
            behind: behind,
            dirty: dirty,
            lastFetch: Date(timeIntervalSince1970: 1_700_000_000),
            prState: prState
        )
    }

    func testStateBadgeMappingAndPullEnableRule() async {
        let upToDate = makeRepo(name: "o/up", state: .upToDate)
        let behindClean = makeRepo(name: "o/behind", state: .behind, behind: 2)
        let ahead = makeRepo(name: "o/ahead", state: .ahead, ahead: 1)
        let diverged = makeRepo(name: "o/div", state: .diverged, ahead: 1, behind: 1)
        let dirty = makeRepo(name: "o/dirty", state: .dirty, behind: 1, dirty: true)
        let missing = makeRepo(name: "o/missing", state: .missing)

        let counts = RepoCounts(upToDate: 1, behind: 1, ahead: 1, diverged: 1, dirty: 1, missing: 1)
        let response = ReposStatusResponse(
            repos: [upToDate, behindClean, ahead, diverged, dirty, missing],
            counts: counts,
            lastSuccessfulPoll: nil
        )
        let model = ReposViewModel(client: MockReposClient(statusResult: .success(response)))
        await model.refresh()

        XCTAssertEqual(model.badgeText(for: upToDate), "Up to date")
        XCTAssertEqual(model.badgeText(for: behindClean), "Behind 2")
        XCTAssertEqual(model.badgeText(for: ahead), "Ahead 1")
        XCTAssertEqual(model.badgeText(for: diverged), "Diverged")
        XCTAssertEqual(model.badgeText(for: dirty), "Dirty")
        XCTAssertEqual(model.badgeText(for: missing), "Missing")

        XCTAssertFalse(model.canPull(upToDate))
        XCTAssertTrue(model.canPull(behindClean))
        XCTAssertFalse(model.canPull(ahead))
        XCTAssertFalse(model.canPull(diverged))
        XCTAssertFalse(model.canPull(dirty))
        XCTAssertFalse(model.canPull(missing))

        XCTAssertEqual(model.counts, counts)
        XCTAssertEqual(model.pillColor, .red)
    }

    func testPillColorsGreenAndAmber() async {
        let greenResp = ReposStatusResponse(
            repos: [makeRepo(name: "o/a", state: .upToDate)],
            counts: RepoCounts(upToDate: 1, behind: 0, ahead: 0, diverged: 0, dirty: 0, missing: 0),
            lastSuccessfulPoll: nil
        )
        let greenModel = ReposViewModel(client: MockReposClient(statusResult: .success(greenResp)))
        await greenModel.refresh()
        XCTAssertEqual(greenModel.pillColor, .green)

        let amberResp = ReposStatusResponse(
            repos: [makeRepo(name: "o/b", state: .behind, behind: 1)],
            counts: RepoCounts(upToDate: 0, behind: 1, ahead: 0, diverged: 0, dirty: 0, missing: 0),
            lastSuccessfulPoll: nil
        )
        let amberModel = ReposViewModel(client: MockReposClient(statusResult: .success(amberResp)))
        await amberModel.refresh()
        XCTAssertEqual(amberModel.pillColor, .amber)
    }

    func testOfflineStateWhenEngineUnavailable() async {
        let model = ReposViewModel(client: MockReposClient(statusResult: .failure(SocketClientError.engineUnavailable)))
        await model.refresh()

        XCTAssertTrue(model.isOffline)
        XCTAssertEqual(model.errorMessage, "Engine not running")
        XCTAssertEqual(model.pillColor, .red)
        XCTAssertEqual(model.collapsedLabel, "0 repos")
    }

    func testPullRequiresConfirmationAndRefreshes() async {
        let behind = makeRepo(name: "o/behind", state: .behind, behind: 1)
        let resp = ReposStatusResponse(
            repos: [behind],
            counts: RepoCounts(upToDate: 0, behind: 1, ahead: 0, diverged: 0, dirty: 0, missing: 0),
            lastSuccessfulPoll: nil
        )
        let client = MockReposClient(statusResult: .success(resp))
        let model = ReposViewModel(client: client)
        await model.refresh()

        model.requestPull(behind)
        XCTAssertEqual(model.pendingPullRepo?.name, "o/behind")
        XCTAssertEqual(client.pulledRepos, [])

        await model.confirmPull()
        XCTAssertNil(model.pendingPullRepo)
        XCTAssertEqual(client.pulledRepos, ["o/behind"])
    }
}
