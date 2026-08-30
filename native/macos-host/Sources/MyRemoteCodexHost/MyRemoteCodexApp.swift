import AppKit
import SwiftUI

@main
struct MyRemoteCodexApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            ContentView(model: model)
                .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in
                    model.applicationWillTerminate()
                }
        }
        .windowStyle(.titleBar)
        .commands {
            CommandGroup(after: .appInfo) {
                Button(model.text("打开本机页面", "Open local page")) { model.openLocalPage() }
                    .disabled(model.servicePhase != .running)
            }
        }
    }
}
