import SwiftUI

struct DashboardPlaceholder: View {
    @ObservedObject var model: StatusViewModel

    var body: some View {
        ContentUnavailableView(
            "ctx Companion dashboard",
            systemImage: model.status.state == .offline ? "bolt.slash.circle" : "checkmark.circle",
            description: Text(model.status.state == .offline ? "The ctx engine is not running. Start it from the menu bar, then refresh." : "Repository and approval views are coming next.")
        )
        .frame(minWidth: 460, minHeight: 280)
    }
}
