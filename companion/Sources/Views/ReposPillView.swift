import AppKit
import SwiftUI

struct ReposPillView: View {
    @ObservedObject var model: ReposViewModel
    @ObservedObject var approvalsModel: ApprovalsViewModel
    @ObservedObject var notifications: NotificationCoordinator
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Group {
            if model.isExpanded {
                expandedView
            } else {
                collapsedView
            }
        }
        .onChange(of: notifications.shouldOpenApprovals) { _, shouldOpen in
            guard shouldOpen else { return }
            notifications.shouldOpenApprovals = false
            openWindow(id: "approvals")
            NSApplication.shared.activate(ignoringOtherApps: true)
        }
        .confirmationDialog(
            "Pull \(model.pendingPullRepo?.name ?? "repository")?",
            isPresented: Binding(
                get: { model.pendingPullRepo != nil },
                set: { if !$0 { model.cancelPull() } }
            ),
            titleVisibility: .visible
        ) {
            Button("Fast-forward pull") {
                Task { await model.confirmPull() }
            }
            Button("Cancel", role: .cancel) {
                model.cancelPull()
            }
        } message: {
            Text("Runs git fetch and merge --ff-only for this repository.")
        }
    }

    private var collapsedView: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(dotColor)
                .frame(width: 9, height: 9)
            Text(model.collapsedLabel)
                .font(.system(size: 12, weight: .semibold))
                .lineLimit(1)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(.ultraThickMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(.primary.opacity(0.12), lineWidth: 1))
        .contentShape(Capsule())
        .onTapGesture {
            model.setExpanded(true)
        }
    }

    private var expandedView: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Circle()
                    .fill(dotColor)
                    .frame(width: 9, height: 9)
                Text(model.collapsedLabel)
                    .font(.headline)
                Spacer()
                Button("Approvals (\(approvalsModel.items.count))") {
                    openWindow(id: "approvals")
                    NSApplication.shared.activate(ignoringOtherApps: true)
                }
                .controlSize(.small)
                Button {
                    Task { await model.refresh() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .disabled(model.isRefreshing)
                Button {
                    model.setExpanded(false)
                } label: {
                    Image(systemName: "chevron.up")
                }
                .buttonStyle(.borderless)
            }

            if model.isOffline {
                HStack {
                    Text("Engine not running")
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Start ctx engine") { EngineStarter.start() }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                }
                .padding(8)
                .background(.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
            } else if let error = model.errorMessage {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            summaryBar

            Divider()

            if model.repos.isEmpty {
                Spacer()
                Text(model.isOffline ? "Connect to ctx engine to view repositories." : "No allowlisted repositories configured.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(model.repos) { repo in
                            repoRow(repo)
                        }
                    }
                }
            }

            Divider()

            VStack(alignment: .leading, spacing: 4) {
                if notifications.permissionDenied {
                    Text("Notifications denied in System Settings.")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
                HStack(spacing: 12) {
                    Toggle("Notify approvals", isOn: $notifications.approvalsEnabled)
                        .toggleStyle(.checkbox)
                        .font(.caption2)
                    Toggle("Notify engine errors", isOn: $notifications.engineErrorsEnabled)
                        .toggleStyle(.checkbox)
                        .font(.caption2)
                }
            }
        }
        .padding(14)
        .frame(width: 480, height: 410)
        .background(.ultraThickMaterial, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(.primary.opacity(0.14), lineWidth: 1))
    }

    private var summaryBar: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(
                "\(model.counts.upToDate) up to date · \(model.counts.behind) behind · \(model.counts.ahead) ahead · \(model.counts.diverged) diverged · \(model.counts.dirty) dirty · \(model.counts.missing) missing"
            )
            .font(.caption)
            .foregroundStyle(.secondary)
            Text("Last poll: \(formattedDate(model.lastSuccessfulPoll))")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    private func repoRow(_ repo: RepoItem) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(repo.name)
                        .font(.system(size: 12, weight: .semibold))
                        .lineLimit(1)
                    Text(repo.branch)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(model.badgeText(for: repo))
                        .font(.caption2.weight(.medium))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(badgeColor(for: repo).opacity(0.16), in: Capsule())
                        .foregroundStyle(badgeColor(for: repo))
                }
                Text("Fetched: \(formattedDate(repo.lastFetch))")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if let prURL = repo.prURL {
                Button("PR") {
                    NSWorkspace.shared.open(prURL)
                }
                .controlSize(.small)
            }
            Button("Reveal") {
                if let path = repo.path {
                    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
                }
            }
            .controlSize(.small)
            .disabled(repo.path == nil)
            Button(model.pullingRepo == repo.name ? "Pulling..." : "Pull") {
                model.requestPull(repo)
            }
            .controlSize(.small)
            .disabled(!model.canPull(repo))
        }
        .padding(8)
        .background(.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
    }

    private var dotColor: Color {
        switch model.pillColor {
        case .green: .green
        case .amber: .orange
        case .red: .red
        }
    }

    private func badgeColor(for repo: RepoItem) -> Color {
        switch repo.state {
        case .upToDate: .green
        case .behind, .ahead, .dirty, .missing: .orange
        case .diverged: .red
        }
    }

    private func formattedDate(_ date: Date?) -> String {
        guard let date else { return "Never" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}
