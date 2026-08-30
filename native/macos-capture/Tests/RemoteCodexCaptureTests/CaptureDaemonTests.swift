import XCTest
@testable import RemoteCodexCapture

private final class RecordingStatusWriter: CaptureStatusWriting {
    private(set) var error: Error?
    private var completed: (() -> Void)?

    func fail(_ error: Error, completed: (() -> Void)?) {
        self.error = error
        self.completed = completed
    }

    func completeWrite() {
        completed?()
    }
}

final class CaptureDaemonTests: XCTestCase {
    func testPermissionFailureTerminatesAfterSendingStatus() {
        var terminated = false
        let daemon = CaptureDaemon(terminate: { terminated = true })
        let writer = RecordingStatusWriter()

        daemon.handleSessionFailure(CaptureError.screenCapturePermission, writer: writer)

        XCTAssertEqual(
            writer.error?.localizedDescription,
            "缺少屏幕录制权限；请在系统设置中允许 My Remote Codex Capture，然后刷新远程页面"
        )
        XCTAssertFalse(terminated)

        writer.completeWrite()

        XCTAssertTrue(terminated)
    }

    func testOtherFailuresKeepDaemonRunning() {
        var terminated = false
        let daemon = CaptureDaemon(terminate: { terminated = true })
        let writer = RecordingStatusWriter()

        daemon.handleSessionFailure(CaptureError.windowNotFound("com.openai.codex"), writer: writer)
        writer.completeWrite()

        XCTAssertFalse(terminated)
    }
}
