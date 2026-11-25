import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let reposViewModel = ReposViewModel()
    let approvalsViewModel = ApprovalsViewModel()
    private var pillController: FloatingPillController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let controller = FloatingPillController(reposModel: reposViewModel, approvalsModel: approvalsViewModel)
        pillController = controller
        controller.show()
        Task {
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
