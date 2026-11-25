import AppKit
import Combine
import SwiftUI
import UserNotifications

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let reposViewModel = ReposViewModel()
    let approvalsViewModel = ApprovalsViewModel()
    let notifications = NotificationCoordinator()
    private let notificationDelegate = NotificationDelegate()
    private var pillController: FloatingPillController?
    private var cancellables: Set<AnyCancellable> = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        notificationDelegate.onOpenApprovals = { [weak self] in
            self?.notifications.shouldOpenApprovals = true
        }
        UNUserNotificationCenter.current().delegate = notificationDelegate

        let controller = FloatingPillController(
            reposModel: reposViewModel,
            approvalsModel: approvalsViewModel,
            notificationsModel: notifications
        )
        pillController = controller
        controller.show()

        approvalsViewModel.$items
            .dropFirst()
            .sink { [weak self] items in
                Task { @MainActor [weak self] in
                    await self?.notifications.processApprovals(items)
                }
            }
            .store(in: &cancellables)

        Publishers.CombineLatest(reposViewModel.$isOffline, reposViewModel.$errorMessage)
            .dropFirst()
            .sink { [weak self] isOffline, errorMessage in
                Task { @MainActor [weak self] in
                    await self?.notifications.processEngineState(isOffline: isOffline, errorMessage: errorMessage)
                }
            }
            .store(in: &cancellables)

        Task {
            await notifications.requestPermissionIfNeeded()
            await reposViewModel.refresh()
            await approvalsViewModel.refresh()
        }
    }
}

@main
struct CtxCompanionApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var status = StatusViewModel()

    var body: some Scene {
        MenuBarExtra {
            StatusMenuView(model: status)
                .task { await status.refresh() }
        } label: {
            Image(systemName: iconName(for: status.status))
        }
        WindowGroup("ctx Companion Dashboard", id: "dashboard") {
            DashboardPlaceholder(model: status)
        }
        WindowGroup("ctx Approvals", id: "approvals") {
            ApprovalsCenterView(model: appDelegate.approvalsViewModel)
        }
    }

    private func iconName(for status: EngineStatus) -> String {
        switch status.state {
        case .healthy: "checkmark.circle.fill"
        case .attention: "exclamationmark.circle.fill"
        case .offline: "bolt.slash.circle.fill"
        }
    }
}
