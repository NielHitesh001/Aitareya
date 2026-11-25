import Foundation
import UserNotifications

struct LocalNotificationPayload: Equatable, Sendable {
    let identifier: String
    let title: String
    let body: String
    let kind: String
}

protocol UserNotificationCenterProtocol: Sendable {
    func requestAlertAuthorization() async -> Bool
    func post(_ payload: LocalNotificationPayload) async
}

struct SystemNotificationCenterAdapter: UserNotificationCenterProtocol {
    func requestAlertAuthorization() async -> Bool {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        if settings.authorizationStatus == .denied {
            return false
        }
        if settings.authorizationStatus == .authorized {
            return true
        }
        return (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
    }

    func post(_ payload: LocalNotificationPayload) async {
        let content = UNMutableNotificationContent()
        content.title = payload.title
        content.body = payload.body
        content.sound = .default
        content.userInfo = ["kind": payload.kind]
        let request = UNNotificationRequest(identifier: payload.identifier, content: content, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
    }
}

@MainActor
final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    var onOpenApprovals: (() -> Void)?

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        await MainActor.run {
            self.onOpenApprovals?()
        }
    }
}

@MainActor
final class NotificationCoordinator: ObservableObject {
    private enum DefaultsKey {
        static let approvalsEnabled = "ctx.notifications.approvalsEnabled"
        static let engineErrorsEnabled = "ctx.notifications.engineErrorsEnabled"
        static let seenApprovalIds = "ctx.notifications.seenApprovalIds"
    }

    @Published var approvalsEnabled: Bool {
        didSet { defaults.set(approvalsEnabled, forKey: DefaultsKey.approvalsEnabled) }
    }
    @Published var engineErrorsEnabled: Bool {
        didSet { defaults.set(engineErrorsEnabled, forKey: DefaultsKey.engineErrorsEnabled) }
    }
    @Published private(set) var permissionDenied = false
    @Published var shouldOpenApprovals = false

    private let center: any UserNotificationCenterProtocol
    private let defaults: UserDefaults
    private var seenApprovalIds: Set<String>
    private var needsFirstLaunchSeed: Bool
    private var wasInErrorState = false

    init(
        center: any UserNotificationCenterProtocol = SystemNotificationCenterAdapter(),
        defaults: UserDefaults = .standard
    ) {
        self.center = center
        self.defaults = defaults
        if defaults.object(forKey: DefaultsKey.approvalsEnabled) != nil {
            self.approvalsEnabled = defaults.bool(forKey: DefaultsKey.approvalsEnabled)
        } else {
            self.approvalsEnabled = true
        }
        if defaults.object(forKey: DefaultsKey.engineErrorsEnabled) != nil {
            self.engineErrorsEnabled = defaults.bool(forKey: DefaultsKey.engineErrorsEnabled)
        } else {
            self.engineErrorsEnabled = true
        }
        self.needsFirstLaunchSeed = defaults.object(forKey: DefaultsKey.seenApprovalIds) == nil
        let stored = defaults.stringArray(forKey: DefaultsKey.seenApprovalIds) ?? []
        self.seenApprovalIds = Set(stored)
    }

    func requestPermissionIfNeeded() async {
        let granted = await center.requestAlertAuthorization()
        permissionDenied = !granted
    }

    func processApprovals(_ items: [ApprovalItem]) async {
        if needsFirstLaunchSeed {
            needsFirstLaunchSeed = false
            for item in items {
                seenApprovalIds.insert(item.id)
            }
            defaults.set(Array(seenApprovalIds).sorted(), forKey: DefaultsKey.seenApprovalIds)
            return
        }

        let newItems = items.filter { !seenApprovalIds.contains($0.id) }
        guard !newItems.isEmpty else { return }

        for item in newItems {
            seenApprovalIds.insert(item.id)
        }
        defaults.set(Array(seenApprovalIds).sorted(), forKey: DefaultsKey.seenApprovalIds)

        guard approvalsEnabled else { return }
        for item in newItems {
            await center.post(
                LocalNotificationPayload(
                    identifier: "approval-\(item.id)",
                    title: "New pending approval",
                    body: "\(item.projectName): \(item.targetFile)",
                    kind: "approval"
                )
            )
        }
    }

    func processEngineState(isOffline: Bool, errorMessage: String?) async {
        let hasError = isOffline || errorMessage != nil
        if hasError {
            guard !wasInErrorState else { return }
            wasInErrorState = true
            guard engineErrorsEnabled else { return }
            let body = isOffline ? "The ctx engine is offline." : (errorMessage ?? "Engine error")
            await center.post(
                LocalNotificationPayload(
                    identifier: "engine-error-\(UUID().uuidString)",
                    title: "ctx engine attention",
                    body: body,
                    kind: "engine"
                )
            )
        } else {
            wasInErrorState = false
        }
    }
}
