import SwiftUI

struct StatusMenuView: View {
    @ObservedObject var model: StatusViewModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Group {
            Text(model.engineMessage)
            if model.status.state == .offline {
                Button("Start ctx engine") { EngineStarter.start() }
                Text("Duck will reconnect when the launch agent is ready.")
                    .foregroundStyle(.secondary)
            } else {
                Text("Last poll: \(lastPoll)")
                Text("Allowlisted repos: \(model.status.allowlistedRepoCount)")
                Text("Pending approvals: \(model.status.pendingApprovalCount)")
            }
            Divider()
            Button("Refresh status") { Task { await model.refresh() } }
            Button("Open Dashboard") { openWindow(id: "dashboard") }
            Divider()
            Button("Quit ctx Companion") { NSApplication.shared.terminate(nil) }
        }
    }

    private var lastPoll: String {
        guard let date = model.status.lastPollAt else { return "Not yet" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}

enum EngineStarter {
    static func start() {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = ["kickstart", "-k", "gui/\(getuid())/com.ctx.api"]
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        try? task.run()
    }
}
