import Combine
import XCTest
@testable import CtxCompanion

private final class FakeNotificationCenterForApprovals: UserNotificationCenterProtocol, @unchecked Sendable {
    private(set) var posted: [LocalNotificationPayload] = []
    func requestAlertAuthorization() async -> Bool { true }
    func post(_ payload: LocalNotificationPayload) async { posted.append(payload) }
}

private final class MockApprovalsClient: ApprovalsClient, @unchecked Sendable {
    var listResult: Result<ApprovalsListResponse, Error>
    var acceptResult: Result<ApprovalDecisionResponse, Error>
    var rejectResult: Result<ApprovalDecisionResponse, Error>
    private(set) var acceptedIds: [String] = []
    private(set) var rejectedIds: [String] = []

    init(
        listResult: Result<ApprovalsListResponse, Error>,
        acceptResult: Result<ApprovalDecisionResponse, Error> = .success(
            ApprovalDecisionResponse(id: "a1", status: "accepted", message: "Applied rules update.")
        ),
        rejectResult: Result<ApprovalDecisionResponse, Error> = .success(
            ApprovalDecisionResponse(id: "a1", status: "rejected", message: "Rejected rules update.")
        )
    ) {
        self.listResult = listResult
        self.acceptResult = acceptResult
        self.rejectResult = rejectResult
    }

    func approvalsList(status: String?) async throws -> ApprovalsListResponse {
        try listResult.get()
    }

    func approvalsAccept(id: String) async throws -> ApprovalDecisionResponse {
        acceptedIds.append(id)
        return try acceptResult.get()
    }

    func approvalsReject(id: String) async throws -> ApprovalDecisionResponse {
        rejectedIds.append(id)
        return try rejectResult.get()
    }
}

@MainActor
final class ApprovalsViewModelTests: XCTestCase {
    private func makeItem(id: String = "a1", kinds: [String] = ["github-token"]) -> ApprovalItem {
        ApprovalItem(
            id: id,
            projectName: "HERMES",
            targetFile: "AGENTS.md",
            createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            diffText: "--- AGENTS.md\n+++ AGENTS.md\n@@\n+[REDACTED:github-token]\n",
            secretScanKinds: kinds
        )
    }

    func testListMappingIncludesSecretScanKindsAndPreview() async {
        let item = makeItem()
        let client = MockApprovalsClient(listResult: .success(ApprovalsListResponse(approvals: [item])))
        let model = ApprovalsViewModel(client: client)

        await model.refresh()

        XCTAssertEqual(model.items, [item])
        XCTAssertEqual(model.selectedItem?.id, "a1")
        XCTAssertEqual(model.selectedItem?.secretScanKinds, ["github-token"])
        XCTAssertEqual(model.selectedItem?.diffPreview, "+[REDACTED:github-token]")
    }

    func testAcceptConfirmationFlow() async {
        let item = makeItem()
        let client = MockApprovalsClient(listResult: .success(ApprovalsListResponse(approvals: [item])))
        let model = ApprovalsViewModel(client: client)
        await model.refresh()

        model.requestAccept(item)
        XCTAssertEqual(model.pendingAcceptItem?.id, "a1")
        XCTAssertEqual(client.acceptedIds, [])

        client.listResult = .success(ApprovalsListResponse(approvals: []))
        await model.confirmAccept()
        XCTAssertNil(model.pendingAcceptItem)
        XCTAssertEqual(client.acceptedIds, ["a1"])
        XCTAssertTrue(model.items.isEmpty)
    }

    func testStaleStateDisablesFurtherDecisions() async {
        let item = makeItem()
        let client = MockApprovalsClient(
            listResult: .success(ApprovalsListResponse(approvals: [item])),
            acceptResult: .success(ApprovalDecisionResponse(id: "a1", status: "stale", message: "Approval is stale"))
        )
        let model = ApprovalsViewModel(client: client)
        await model.refresh()

        model.requestAccept(item)
        await model.confirmAccept()

        XCTAssertTrue(model.isStale(item))
        XCTAssertFalse(model.canDecide(item))
        model.requestAccept(item)
        XCTAssertNil(model.pendingAcceptItem)
    }

    func testDuplicateAcceptAlreadyDecided() async {
        let item = makeItem()
        let client = MockApprovalsClient(
            listResult: .success(ApprovalsListResponse(approvals: [item])),
            acceptResult: .success(ApprovalDecisionResponse(id: "a1", status: "already_decided", message: "already decided"))
        )
        let model = ApprovalsViewModel(client: client)
        await model.refresh()

        model.requestAccept(item)
        client.listResult = .success(ApprovalsListResponse(approvals: []))
        await model.confirmAccept()

        XCTAssertEqual(model.statusMessage, "Already decided")
        XCTAssertTrue(model.items.isEmpty)
    }

    func testRefreshNewApprovalReachesProcessApprovalsAndUnchangedRefreshDoesNotRepeat() async {
        let suite = "ctx.approvals.poll.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        let center = FakeNotificationCenterForApprovals()
        let coordinator = NotificationCoordinator(center: center, defaults: defaults)
        await coordinator.processApprovals([])

        let item = makeItem(id: "poll-1")
        let client = MockApprovalsClient(listResult: .success(ApprovalsListResponse(approvals: [item])))
        let model = ApprovalsViewModel(client: client)

        var emitted: [[ApprovalItem]] = []
        let cancellable = model.$items
            .dropFirst()
            .sink { items in
                emitted.append(items)
            }

        await model.refresh()
        XCTAssertEqual(emitted.count, 1)
        for items in emitted {
            await coordinator.processApprovals(items)
        }
        XCTAssertEqual(center.posted.count, 1)

        emitted.removeAll()
        await model.refresh()
        XCTAssertEqual(emitted.count, 1)
        for items in emitted {
            await coordinator.processApprovals(items)
        }
        XCTAssertEqual(center.posted.count, 1)

        cancellable.cancel()
    }
}
