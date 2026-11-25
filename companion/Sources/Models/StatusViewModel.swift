import Foundation

@MainActor
final class StatusViewModel: ObservableObject {
    @Published private(set) var status = EngineStatus.offline
    @Published private(set) var isRefreshing = false
    @Published private(set) var engineMessage = "Engine not running"

    private let client: any StatusClient

    init(client: any StatusClient = UnixSocketClient()) {
        self.client = client
    }

    func refresh() async {
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            status = try await client.status()
            engineMessage = status.state == .offline ? "Engine not running" : "Engine connected"
        } catch {
            status = .offline
            engineMessage = "Engine not running"
        }
    }
}
