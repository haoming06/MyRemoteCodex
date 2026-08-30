import AppKit
import CoreMedia
import CoreVideo
import CoreGraphics
import Darwin
import Foundation
import Network
import ScreenCaptureKit
import VideoToolbox

struct Options: Codable {
    var bundleId = "com.openai.codex"
    var fps: Int32 = 30
    var maxWidth = 1600
    var bitrate = 3_000_000

    static func parse(_ arguments: [String]) throws -> Options {
        var options = Options()
        var index = 1
        while index < arguments.count {
            guard index + 1 < arguments.count else { throw CaptureError.invalidArguments }
            let value = arguments[index + 1]
            switch arguments[index] {
            case "--bundle-id": options.bundleId = value
            case "--fps": options.fps = Int32(value) ?? 0
            case "--max-width": options.maxWidth = Int(value) ?? 0
            case "--bitrate": options.bitrate = Int(value) ?? 0
            default: throw CaptureError.invalidArguments
            }
            index += 2
        }
        guard !options.bundleId.isEmpty,
              (10...60).contains(options.fps),
              (640...4096).contains(options.maxWidth),
              (500_000...30_000_000).contains(options.bitrate)
        else { throw CaptureError.invalidArguments }
        return options
    }
}

enum CaptureError: LocalizedError {
    case busy
    case connectionClosed
    case invalidArguments
    case unauthorized
    case windowNotFound(String)
    case encoder(OSStatus)
    case missingPixelBuffer
    case screenCapturePermission

    var errorDescription: String? {
        switch self {
        case .busy:
            return "原生采集器正在被另一个会话使用"
        case .connectionClosed:
            return "My Remote Codex 已断开原生采集连接"
        case .invalidArguments:
            return "usage: remote-codex-capture --bundle-id ID --fps FPS --max-width WIDTH --bitrate BPS"
        case .unauthorized:
            return "原生采集连接鉴权失败"
        case .windowNotFound(let bundleId):
            return "no capturable window found for bundle identifier \(bundleId)"
        case .encoder(let status):
            return "VideoToolbox encoder error: \(status)"
        case .missingPixelBuffer:
            return "ScreenCaptureKit sample has no pixel buffer"
        case .screenCapturePermission:
            return "缺少屏幕录制权限；请在系统设置中允许 My Remote Codex Capture，然后刷新远程页面"
        }
    }
}

final class FrameWriter: @unchecked Sendable {
    private let lock = NSLock()
    private let output: @Sendable (Data) -> Void

    init(output: @escaping @Sendable (Data) -> Void) {
        self.output = output
    }

    convenience init(fileHandle: FileHandle) {
        self.init { fileHandle.write($0) }
    }

    func write(data: Data, keyframe: Bool, width: Int, height: Int, timestamp90k: UInt32) {
        var packet = Data(capacity: 24 + data.count)
        packet.append(bigEndian: UInt32(0x4d524356))
        packet.append(1)
        packet.append(keyframe ? 1 : 0)
        packet.append(bigEndian: UInt16(24))
        packet.append(bigEndian: UInt32(width))
        packet.append(bigEndian: UInt32(height))
        packet.append(bigEndian: timestamp90k)
        packet.append(bigEndian: UInt32(data.count))
        packet.append(data)
        lock.lock()
        output(packet)
        lock.unlock()
    }
}

extension Data {
    mutating func append<T: FixedWidthInteger>(bigEndian value: T) {
        var encoded = value.bigEndian
        Swift.withUnsafeBytes(of: &encoded) { append(contentsOf: $0) }
    }
}

final class H264Encoder: @unchecked Sendable {
    private var session: VTCompressionSession?
    private let writer: FrameWriter
    private let width: Int
    private let height: Int
    private let fps: Int32
    private let stateLock = NSLock()
    private var forceNextKeyframe = false

    init(width: Int, height: Int, fps: Int32, bitrate: Int, writer: FrameWriter) throws {
        self.width = width
        self.height = height
        self.fps = fps
        self.writer = writer

        let specification = [
            kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder as String: true,
        ] as CFDictionary
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: Int32(width),
            height: Int32(height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: specification,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: { context, _, status, _, sampleBuffer in
                guard status == noErr, let context, let sampleBuffer else { return }
                Unmanaged<H264Encoder>.fromOpaque(context).takeUnretainedValue().consume(sampleBuffer)
            },
            refcon: Unmanaged.passUnretained(self).toOpaque(),
            compressionSessionOut: &session
        )
        guard status == noErr, let session else { throw CaptureError.encoder(status) }
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_Baseline_AutoLevel)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: bitrate as CFNumber)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: fps as CFNumber)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: (fps * 2) as CFNumber)
        let prepareStatus = VTCompressionSessionPrepareToEncodeFrames(session)
        guard prepareStatus == noErr else { throw CaptureError.encoder(prepareStatus) }
    }

    deinit {
        if let session {
            VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
            VTCompressionSessionInvalidate(session)
        }
    }

    func requestKeyframe() {
        stateLock.lock()
        forceNextKeyframe = true
        stateLock.unlock()
    }

    func encode(_ sampleBuffer: CMSampleBuffer) throws {
        guard let session, let pixelBuffer = sampleBuffer.imageBuffer else {
            throw CaptureError.missingPixelBuffer
        }
        stateLock.lock()
        let keyframe = forceNextKeyframe
        forceNextKeyframe = false
        stateLock.unlock()
        let properties = keyframe
            ? [kVTEncodeFrameOptionKey_ForceKeyFrame as String: true] as CFDictionary
            : nil
        let timestamp = sampleBuffer.presentationTimeStamp
        let status = VTCompressionSessionEncodeFrame(
            session,
            imageBuffer: pixelBuffer,
            presentationTimeStamp: timestamp,
            duration: CMTime(value: 1, timescale: fps),
            frameProperties: properties,
            sourceFrameRefcon: nil,
            infoFlagsOut: nil
        )
        guard status == noErr else { throw CaptureError.encoder(status) }
    }

    private func consume(_ sampleBuffer: CMSampleBuffer) {
        guard sampleBuffer.isValid, let blockBuffer = sampleBuffer.dataBuffer else { return }
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
        let firstAttachment = (attachments as? [[CFString: Any]])?.first
        let keyframe = firstAttachment?[kCMSampleAttachmentKey_NotSync] as? Bool != true
        var annexB = Data()

        if keyframe, let format = sampleBuffer.formatDescription {
            for parameterIndex in 0..<2 {
                var pointer: UnsafePointer<UInt8>?
                var size = 0
                var count = 0
                var headerLength: Int32 = 0
                let status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                    format,
                    parameterSetIndex: parameterIndex,
                    parameterSetPointerOut: &pointer,
                    parameterSetSizeOut: &size,
                    parameterSetCountOut: &count,
                    nalUnitHeaderLengthOut: &headerLength
                )
                if status == noErr, let pointer {
                    annexB.append(contentsOf: [0, 0, 0, 1])
                    annexB.append(pointer, count: size)
                }
            }
        }

        let length = CMBlockBufferGetDataLength(blockBuffer)
        var avcc = Data(count: length)
        let copyStatus = avcc.withUnsafeMutableBytes { bytes in
            CMBlockBufferCopyDataBytes(blockBuffer, atOffset: 0, dataLength: length, destination: bytes.baseAddress!)
        }
        guard copyStatus == noErr else { return }
        var offset = 0
        while offset + 4 <= avcc.count {
            let nalLength = avcc[offset..<(offset + 4)].reduce(0) { ($0 << 8) | Int($1) }
            offset += 4
            guard nalLength > 0, offset + nalLength <= avcc.count else { return }
            annexB.append(contentsOf: [0, 0, 0, 1])
            annexB.append(avcc[offset..<(offset + nalLength)])
            offset += nalLength
        }
        guard !annexB.isEmpty else { return }
        let seconds = sampleBuffer.presentationTimeStamp.seconds
        let timestamp = seconds.isFinite ? UInt32(truncatingIfNeeded: Int64(seconds * 90_000)) : 0
        writer.write(data: annexB, keyframe: keyframe, width: width, height: height, timestamp90k: timestamp)
    }
}

final class CaptureOutput: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let encoder: H264Encoder
    private let stopped: @Sendable (Error) -> Void

    init(encoder: H264Encoder, stopped: @escaping @Sendable (Error) -> Void) {
        self.encoder = encoder
        self.stopped = stopped
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen else { return }
        do { try encoder.encode(sampleBuffer) }
        catch { FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8)) }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        FileHandle.standardError.write(Data("ScreenCaptureKit stopped: \(error.localizedDescription)\n".utf8))
        stopped(error)
    }
}

final class CaptureSession: @unchecked Sendable {
    let stream: SCStream
    let output: CaptureOutput
    let encoder: H264Encoder
    let writer: FrameWriter
    let description: String

    init(stream: SCStream, output: CaptureOutput, encoder: H264Encoder, writer: FrameWriter, description: String) {
        self.stream = stream
        self.output = output
        self.encoder = encoder
        self.writer = writer
        self.description = description
    }
}

private struct SocketStatus: Codable {
    let type: String
    let detail: String
}

private struct DaemonRequest: Codable {
    let token: String
    let bundleId: String
    let fps: Int32
    let maxWidth: Int
    let bitrate: Int

    var options: Options {
        Options(bundleId: bundleId, fps: fps, maxWidth: maxWidth, bitrate: bitrate)
    }
}

protocol CaptureStatusWriting: AnyObject {
    func fail(_ error: Error, completed: (() -> Void)?)
}

final class ConnectionWriter: CaptureStatusWriting, @unchecked Sendable {
    private let connection: NWConnection
    private let lock = NSLock()
    private var active = false
    private var pending: [Data] = []

    init(connection: NWConnection) {
        self.connection = connection
    }

    func write(_ data: Data) {
        lock.lock()
        if active {
            send(data)
        } else {
            pending.append(data)
        }
        lock.unlock()
    }

    func activate(detail: String) {
        lock.lock()
        sendStatus(type: "ready", detail: detail)
        active = true
        for data in pending { send(data) }
        pending.removeAll(keepingCapacity: false)
        lock.unlock()
    }

    func fail(_ error: Error, completed: (() -> Void)? = nil) {
        lock.lock()
        sendStatus(type: "error", detail: error.localizedDescription) { [connection] in
            connection.cancel()
            completed?()
        }
        lock.unlock()
    }

    private func sendStatus(type: String, detail: String, completed: (() -> Void)? = nil) {
        guard var data = try? JSONEncoder().encode(SocketStatus(type: type, detail: detail)) else {
            completed?()
            return
        }
        data.append(0x0a)
        send(data, completed: completed)
    }

    private func send(_ data: Data, completed: (() -> Void)? = nil) {
        connection.send(content: data, completion: .contentProcessed { _ in completed?() })
    }
}

final class CaptureDaemon: @unchecked Sendable {
    private static let allowedBundleId = "com.openai.codex"
    private let queue = DispatchQueue(label: "com.myremotecodex.capture.daemon", qos: .userInitiated)
    private let stateLock = NSLock()
    private var listener: NWListener?
    private var busy = false
    private var token = ""
    private let terminate: () -> Void

    init(terminate: @escaping () -> Void = {
        DispatchQueue.main.async {
            NSApplication.shared.terminate(nil)
        }
    }) {
        self.terminate = terminate
    }

    func start(port: UInt16, tokenPath: String) throws {
        _ = umask(S_IRWXG | S_IRWXO)
        token = UUID().uuidString.replacingOccurrences(of: "-", with: "")
            + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        guard let listenerPort = NWEndpoint.Port(rawValue: port) else { throw CaptureError.invalidArguments }
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: listenerPort)
        let listener = try NWListener(using: parameters)
        listener.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                guard let self else { return }
                do {
                    try Data(self.token.utf8).write(to: URL(fileURLWithPath: tokenPath), options: .atomic)
                    chmod(tokenPath, S_IRUSR | S_IWUSR)
                } catch {
                    FileHandle.standardError.write(Data("无法写入原生采集鉴权令牌：\(error.localizedDescription)\n".utf8))
                    exit(1)
                }
            case .failed(let error):
                FileHandle.standardError.write(Data("原生采集监听失败：\(error.localizedDescription)\n".utf8))
                exit(1)
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { return }
            connection.start(queue: self.queue)
            Task { await self.serve(connection) }
        }
        listener.start(queue: queue)
        self.listener = listener
    }

    private func serve(_ connection: NWConnection) async {
        guard claimSession() else {
            ConnectionWriter(connection: connection).fail(CaptureError.busy)
            return
        }
        defer { releaseSession() }
        let connectionWriter = ConnectionWriter(connection: connection)
        do {
            let request = try await receiveLine(connection, maximumBytes: 4_096)
            let daemonRequest = try JSONDecoder().decode(DaemonRequest.self, from: request)
            guard daemonRequest.token == token else { throw CaptureError.unauthorized }
            let options = daemonRequest.options
            try validate(options)
            let writer = FrameWriter { connectionWriter.write($0) }
            let session = try await RemoteCodexCapture.startCapture(
                options: options,
                writer: writer,
                stopped: { _ in connection.cancel() }
            )
            connectionWriter.activate(detail: session.description)
            try await receiveCommands(connection, encoder: session.encoder)
            try? await session.stream.stopCapture()
            connection.cancel()
        } catch {
            handleSessionFailure(error, writer: connectionWriter)
        }
    }

    func handleSessionFailure(_ error: Error, writer: CaptureStatusWriting) {
        if let captureError = error as? CaptureError,
           case .screenCapturePermission = captureError {
            writer.fail(error, completed: terminate)
            return
        }
        writer.fail(error, completed: nil)
    }

    private func claimSession() -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard !busy else { return false }
        busy = true
        return true
    }

    private func releaseSession() {
        stateLock.lock()
        busy = false
        stateLock.unlock()
    }

    private func validate(_ options: Options) throws {
        guard options.bundleId == Self.allowedBundleId,
              (10...60).contains(options.fps),
              (640...4096).contains(options.maxWidth),
              (500_000...30_000_000).contains(options.bitrate)
        else { throw CaptureError.invalidArguments }
    }

    private func receiveLine(_ connection: NWConnection, maximumBytes: Int) async throws -> Data {
        var buffer = Data()
        while buffer.count <= maximumBytes {
            let chunk = try await receive(connection, maximumLength: maximumBytes - buffer.count + 1)
            buffer.append(chunk)
            if let newline = buffer.firstIndex(of: 0x0a) {
                return Data(buffer[..<newline])
            }
        }
        throw CaptureError.invalidArguments
    }

    private func receiveCommands(_ connection: NWConnection, encoder: H264Encoder) async throws {
        var buffer = Data()
        while true {
            buffer.append(try await receive(connection, maximumLength: 1_024))
            while let newline = buffer.firstIndex(of: 0x0a) {
                let command = String(decoding: buffer[..<newline], as: UTF8.self)
                buffer.removeSubrange(...newline)
                if command == "keyframe" { encoder.requestKeyframe() }
                if command == "stop" { return }
            }
        }
    }

    private func receive(_ connection: NWConnection, maximumLength: Int) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            connection.receive(minimumIncompleteLength: 1, maximumLength: maximumLength) { data, _, complete, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let data, !data.isEmpty {
                    continuation.resume(returning: data)
                } else if complete {
                    continuation.resume(throwing: CaptureError.connectionClosed)
                } else {
                    continuation.resume(throwing: CaptureError.connectionClosed)
                }
            }
        }
    }
}

@main
struct RemoteCodexCapture {
    @MainActor
    private static var directSession: CaptureSession?

    @MainActor
    static func main() {
        signal(SIGPIPE, SIG_IGN)
        _ = NSApplication.shared.setActivationPolicy(.accessory)

        if CommandLine.arguments.count == 1 {
            do {
                let daemon = CaptureDaemon()
                try daemon.start(port: 43_891, tokenPath: defaultTokenPath())
                withExtendedLifetime(daemon) { NSApplication.shared.run() }
            } catch {
                FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
                exit(1)
            }
            return
        }

        do {
            let options = try Options.parse(CommandLine.arguments)
            Task { @MainActor in
                do {
                    let writer = FrameWriter(fileHandle: .standardOutput)
                    let session = try await startCapture(
                        options: options,
                        writer: writer,
                        stopped: { error in
                            FileHandle.standardError.write(Data("ScreenCaptureKit stopped: \(error.localizedDescription)\n".utf8))
                            exit(2)
                        }
                    )
                    directSession = session
                    FileHandle.standardError.write(Data("\(session.description)\n".utf8))
                    DispatchQueue.global(qos: .utility).async {
                        while let command = readLine() {
                            if command == "keyframe" { session.encoder.requestKeyframe() }
                        }
                    }
                } catch {
                    FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
                    exit(1)
                }
            }
            NSApplication.shared.run()
        } catch {
            FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
            exit(1)
        }
    }

    @MainActor
    static func startCapture(
        options: Options,
        writer: FrameWriter,
        stopped: @escaping @Sendable (Error) -> Void
    ) async throws -> CaptureSession {
        if !CGPreflightScreenCaptureAccess() {
            _ = CGRequestScreenCaptureAccess()
            throw CaptureError.screenCapturePermission
        }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let window = content.windows
            .filter({ $0.owningApplication?.bundleIdentifier == options.bundleId })
            .filter({ $0.frame.width >= 320 && $0.frame.height >= 240 })
            .max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height })
        else { throw CaptureError.windowNotFound(options.bundleId) }

        let filter = SCContentFilter(desktopIndependentWindow: window)
        let scale: CGFloat
        if #available(macOS 14.0, *) {
            scale = max(CGFloat(1), CGFloat(filter.pointPixelScale))
        } else {
            scale = 2
        }
        let sourceWidth = window.frame.width * scale
        let sourceHeight = window.frame.height * scale
        let width = even(Int(min(sourceWidth, CGFloat(options.maxWidth))))
        let height = even(Int(CGFloat(width) * sourceHeight / sourceWidth))
        let encoder = try H264Encoder(
            width: width,
            height: height,
            fps: options.fps,
            bitrate: options.bitrate,
            writer: writer
        )
        let output = CaptureOutput(encoder: encoder, stopped: stopped)
        let configuration = SCStreamConfiguration()
        configuration.width = width
        configuration.height = height
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: options.fps)
        configuration.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        configuration.queueDepth = 3
        configuration.scalesToFit = true
        configuration.showsCursor = true
        configuration.capturesAudio = false
        if #available(macOS 14.0, *) {
            configuration.captureResolution = .best
            configuration.ignoreGlobalClipSingleWindow = true
        }
        let stream = SCStream(filter: filter, configuration: configuration, delegate: output)
        try stream.addStreamOutput(
            output,
            type: .screen,
            sampleHandlerQueue: DispatchQueue(label: "com.myremotecodex.capture.frames", qos: .userInteractive)
        )
        try await stream.startCapture()
        return CaptureSession(
            stream: stream,
            output: output,
            encoder: encoder,
            writer: writer,
            description: "capturing \(window.title ?? "Codex") at \(width)x\(height) \(options.fps)fps"
        )
    }

    private static func defaultTokenPath() -> String {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("my-remote-codex-capture.token")
            .path
    }

    private static func even(_ value: Int) -> Int {
        max(2, value - value % 2)
    }
}
