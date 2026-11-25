import XCTest
@testable import CtxCompanion

private final class FakeNotificationCenter: UserNotificationCenterProtocol, @unchecked Sendable {
    var authorized = true
    private(set) var posted: [LocalNotificationPayload] = []

    func requestAlertAuthorization() async -> Bool {
        authorized
    }

    func post(_ payload: LocalNotificationPayload) async {
        posted.append(payload)
    }
}

@MainActor
final class NotificationCoordinatorTests: XCTestCase {
    private func makeDefaults() -> UserDefaults {
        let suite = "ctx.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    private func makeItem(id: String) -> ApprovalItem {
        ApprovalItem(
            id: id,
            projectName: "HERMES",
            targetFile: "AGENTS.md",
            createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            diffText: "+rule",
            secretScanKinds: []
        )
    }

    func testNewIdTriggersOnceAndSeenIdDoesNotAcrossRelaunch() async {
        let defaults = makeDefaults()
        let center1 = FakeNotificationCenter()
        let coord1 = NotificationCoordinator(center: center1, defaults: defaults)

        await coord1.processApprovals([makeItem(id: "id-1")])
        await coord1.processApprovals([makeItem(id: "id-1")])
        XCTAssertEqual(center1.posted.count, 1)
        XCTAssertEqual(center1.posted.first?.identifier, "approval-id-1")

        let center2 = FakeNotificationCenter()
        let coord2 = NotificationCoordinator(center: center2, defaults: defaults)
        await coord2.processApprovals([makeItem(id: "id-1"), makeItem(id: "id-2")])
        XCTAssertEqual(center2.posted.count, 1)
        XCTAssertEqual(center2.posted.first?.identifier, "approval-id-2")
    }

    func testOfflineTransitionNotifiesOncePerTransition() async {
        let defaults = makeDefaults()
        let center = FakeNotificationCenter()
        let coord = NotificationCoordinator(center: center, defaults: defaults)

        await coord.processEngineState(isOffline: true, errorMessage: "Engine not running")
        await coord.processEngineState(isOffline: true, errorMessage: "Engine not running")
        XCTAssertEqual(center.posted.count, 1)

        await coord.processEngineState(isOffline: false, errorMessage: nil)
        await coord.processEngineState(isOffline: true, errorMessage: "Engine not running")
        XCTAssertEqual(center.posted.count, 2)
    }

    func testTogglesSuppressNotifications() async {
        let defaults = makeDefaults()
        let center = FakeNotificationCenter()
        let coord = NotificationCoordinator(center: center, defaults: defaults)

        coord.approvalsEnabled = false
        coord.engineErrorsEnabled = false

        await coord.processApprovals([makeItem(id: "id-suppressed")])
        await coord.processEngineState(isOffline: true, errorMessage: "Engine not running")
        XCTAssertTrue(center.posted.isEmpty)
    }

    func testDeniedPermissionSetsFlagWithoutCrashing() async {
        let defaults = makeDefaults()
        let center = FakeNotificationCenter()
        center.authorized = false
        let coord = NotificationCoordinator(center: center, defaults: defaults)

        await coord.requestPermissionIfNeeded()
        XCTAssertTrue(coord.permissionDenied)
    }
}
