import SwiftUI

struct ApprovalsCenterView: View {
    @ObservedObject var model: ApprovalsViewModel

    var body: some View {
        NavigationSplitView {
            listPane
        } detail: {
            detailPane
        }
        .frame(minWidth: 680, minHeight: 420)
        .task { await model.refresh() }
        .confirmationDialog(
            "Apply rules update to \(model.pendingAcceptItem?.targetFile ?? "file")?",
            isPresented: Binding(
                get: { model.pendingAcceptItem != nil },
                set: { if !$0 { model.cancelAccept() } }
            ),
            titleVisibility: .visible
        ) {
            Button("Apply rules update") {
                Task { await model.confirmAccept() }
            }
            Button("Cancel", role: .cancel) {
                model.cancelAccept()
            }
        } message: {
            Text("Writes generated content inside ctx markers for \(model.pendingAcceptItem?.projectName ?? "project").")
        }
    }

    private var listPane: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Pending Approvals (\(model.items.count))")
                    .font(.headline)
                Spacer()
                Button {
                    Task { await model.refresh() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .disabled(model.isLoading || model.isDeciding)
            }
            .padding(12)

            Divider()

            if model.items.isEmpty {
                ContentUnavailableView(
                    "No pending approvals",
                    systemImage: "checkmark.circle",
                    description: Text(model.errorMessage ?? "Rules-file updates from watched repositories will appear here.")
                )
            } else {
                List(model.items, selection: $model.selectedId) { item in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(item.projectName)
                                .font(.headline)
                            Spacer()
                            if model.isStale(item) {
                                Text("Stale")
                                    .font(.caption2.weight(.semibold))
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(.orange.opacity(0.2), in: Capsule())
                                    .foregroundStyle(.orange)
                            }
                        }
                        Text(item.targetFile)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        if !item.secretScanKinds.isEmpty {
                            Text("Redacted: \(item.secretScanKinds.joined(separator: ", "))")
                                .font(.caption2)
                                .foregroundStyle(.orange)
                        }
                        Text(item.diffPreview)
                            .font(.caption.monospaced())
                            .lineLimit(2)
                            .foregroundStyle(.tertiary)
                    }
                    .padding(.vertical, 4)
                    .tag(item.id)
                }
            }
        }
        .navigationSplitViewColumnWidth(min: 240, ideal: 280)
    }

    @ViewBuilder
    private var detailPane: some View {
        if let item = model.selectedItem {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(item.projectName) — \(item.targetFile)")
                            .font(.title3.weight(.semibold))
                        Text("Queued \(item.createdAt.formatted(date: .abbreviated, time: .shortened))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if model.isStale(item) {
                        Text("Stale")
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(.orange.opacity(0.2), in: Capsule())
                            .foregroundStyle(.orange)
                    }
                }

                if !item.secretScanKinds.isEmpty {
                    Text("Secret scanner redacted: \(item.secretScanKinds.joined(separator: ", "))")
                        .font(.caption)
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                }

                if model.isStale(item) {
                    Text("This approval is stale because the generated diff changed. Refresh or wait for the next watcher scan.")
                        .font(.caption)
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                }

                if let statusMessage = model.statusMessage {
                    Text(statusMessage)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if let errorMessage = model.errorMessage {
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(.red)
                }

                ScrollView {
                    Text(item.diffText)
                        .font(.system(size: 12, design: .monospaced))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .padding(10)
                }
                .background(.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))

                HStack {
                    Spacer()
                    Button("Reject") {
                        Task { await model.reject(item) }
                    }
                    .disabled(!model.canDecide(item))

                    Button("Accept") {
                        model.requestAccept(item)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!model.canDecide(item))
                }
            }
            .padding(16)
        } else {
            ContentUnavailableView(
                "Select an approval",
                systemImage: "doc.text.magnifyingglass",
                description: Text("Choose a pending rules-file change from the list to inspect its diff.")
            )
        }
    }
}
