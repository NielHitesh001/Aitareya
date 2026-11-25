import Foundation

@MainActor
final class ApprovalsViewModel: ObservableObject {
    @Published private(set) var items: [ApprovalItem] = []
    @Published var selectedId: String?
    @Published private(set) var isLoading = false
    @Published private(set) var isDeciding = false
    @Published private(set) var staleIds: Set<String> = []
    @Published private(set) var statusMessage: String?
    @Published private(set) var errorMessage: String?
    @Published var pendingAcceptItem: ApprovalItem?

    private let client: any ApprovalsClient

    init(client: any ApprovalsClient = UnixSocketClient()) {
        self.client = client
    }

    var selectedItem: ApprovalItem? {
        guard let selectedId else { return items.first }
        return items.first { $0.id == selectedId } ?? items.first
    }

    func isStale(_ item: ApprovalItem) -> Bool {
        staleIds.contains(item.id)
    }

    func canDecide(_ item: ApprovalItem) -> Bool {
        !isDeciding && !isStale(item)
    }

    func refresh() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let response = try await client.approvalsList(status: "pending")
            items = response.approvals
            if let selectedId, !items.contains(where: { $0.id == selectedId }) {
                self.selectedId = items.first?.id
            } else if selectedId == nil {
                selectedId = items.first?.id
            }
            errorMessage = nil
        } catch SocketClientError.engineUnavailable {
            errorMessage = "Engine not running"
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func requestAccept(_ item: ApprovalItem) {
        guard canDecide(item) else { return }
        pendingAcceptItem = item
    }

    func cancelAccept() {
        pendingAcceptItem = nil
    }

    func confirmAccept() async {
        guard let item = pendingAcceptItem else { return }
        pendingAcceptItem = nil
        isDeciding = true
        defer { isDeciding = false }
        do {
            let response = try await client.approvalsAccept(id: item.id)
            errorMessage = nil
            if response.status == "stale" {
                staleIds.insert(item.id)
                statusMessage = "Stale: diff changed since approval was queued."
                return
            }
            if response.status == "already_decided" {
                statusMessage = "Already decided"
                await refresh()
                return
            }
            statusMessage = response.message
            await refresh()
        } catch SocketClientError.engineUnavailable {
            errorMessage = "Engine not running"
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func reject(_ item: ApprovalItem) async {
        guard canDecide(item) else { return }
        isDeciding = true
        defer { isDeciding = false }
        do {
            let response = try await client.approvalsReject(id: item.id)
            errorMessage = nil
            statusMessage = response.message
            await refresh()
        } catch SocketClientError.engineUnavailable {
            errorMessage = "Engine not running"
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
