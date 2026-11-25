import AppKit
import Combine
import SwiftUI

@MainActor
final class FloatingPillController {
    private enum DefaultsKey {
        static let originX = "ctx.floatingPill.originX"
        static let originY = "ctx.floatingPill.originY"
    }

    private let panel: NSPanel
    private var moveObserver: NSObjectProtocol?
    private var expandCancellable: AnyCancellable?

    private static let collapsedSize = NSSize(width: 136, height: 36)
    private static let expandedSize = NSSize(width: 480, height: 360)

    init(reposModel: ReposViewModel, approvalsModel: ApprovalsViewModel) {
        let initialSize = Self.collapsedSize
        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: initialSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isMovableByWindowBackground = true
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.contentView = NSHostingView(rootView: ReposPillView(model: reposModel, approvalsModel: approvalsModel))

        self.panel = panel
        restorePosition(size: initialSize)

        moveObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didMoveNotification,
            object: panel,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.savePosition()
            }
        }

        expandCancellable = reposModel.$isExpanded
            .dropFirst()
            .receive(on: RunLoop.main)
            .sink { [weak self] expanded in
                self?.resize(expanded: expanded)
            }
    }

    func show() {
        panel.orderFrontRegardless()
    }

    private func restorePosition(size: NSSize) {
        let defaults = UserDefaults.standard
        if defaults.object(forKey: DefaultsKey.originX) != nil,
           defaults.object(forKey: DefaultsKey.originY) != nil {
            let x = defaults.double(forKey: DefaultsKey.originX)
            let y = defaults.double(forKey: DefaultsKey.originY)
            panel.setFrameOrigin(NSPoint(x: x, y: y))
            return
        }
        if let screen = NSScreen.main?.visibleFrame {
            let x = screen.maxX - size.width - 24
            let y = screen.maxY - size.height - 24
            panel.setFrameOrigin(NSPoint(x: x, y: y))
        }
    }

    private func savePosition() {
        let defaults = UserDefaults.standard
        defaults.set(Double(panel.frame.origin.x), forKey: DefaultsKey.originX)
        defaults.set(Double(panel.frame.origin.y), forKey: DefaultsKey.originY)
    }

    private func resize(expanded: Bool) {
        let targetSize = expanded ? Self.expandedSize : Self.collapsedSize
        var frame = panel.frame
        let topY = frame.maxY
        frame.size = targetSize
        frame.origin.y = topY - targetSize.height
        panel.setFrame(frame, display: true, animate: true)
    }
}
