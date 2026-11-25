import XCTest
@testable import CtxCompanion

private struct MockStatusClient: StatusClient {
    let response: Result<EngineStatus, Error>
    func status() async throws -> EngineStatus { try response.get() }
}

@MainActor
final class StatusViewModelTests: XCTestCase {
    func testShowsEngineStatusWhenConnectionSucceeds() async {
        let expected = EngineStatus(state: .attention, lastPollAt: nil, allowlistedRepoCount: 3, pendingApprovalCount: 2, errorCount: 0)
        let model = StatusViewModel(client: MockStatusClient(response: .success(expected)))

        await model.refresh()

        XCTAssertEqual(model.status, expected)
        XCTAssertEqual(model.engineMessage, "Engine connected")
    }

    func testShowsOfflineStateWhenEngineCannotBeReached() async {
        let model = StatusViewModel(client: MockStatusClient(response: .failure(SocketClientError.engineUnavailable)))

        await model.refresh()

        XCTAssertEqual(model.status, .offline)
        XCTAssertEqual(model.engineMessage, "Engine not running")
    }
}
