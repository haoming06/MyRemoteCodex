import XCTest
@testable import MyRemoteCodexHost

final class LauncherConfigTests: XCTestCase {
    func testGeneratedPairingCodesAreExactlyEightCharacters() {
        for _ in 0..<50 {
            XCTAssertNotNil(
                LauncherConfig.generatePairingCode()
                    .range(of: "^[A-HJ-NP-Z2-9]{8}$", options: .regularExpression)
            )
        }
    }

    func testPairingCodeMustBeExactlyEightCharacters() {
        var config = LauncherConfig()
        config.pairingCode = "ABCD23456"

        XCTAssertThrowsError(try config.validate(frpToken: "", gatewayToken: "", paths: .current()))
    }

    func testPairingCodeNormalizationIsCaseInsensitive() throws {
        var config = LauncherConfig()
        config.pairingCode = "aBcD2345"

        config.normalize()

        XCTAssertEqual(config.pairingCode, "ABCD2345")
        XCTAssertNoThrow(try config.validate(frpToken: "", gatewayToken: "", paths: .current()))
    }

    func testLegacyLongPairingCodeMigratesToEightCharacters() {
        var config = LauncherConfig()
        config.pairingCode = "abcd2345EFGH"

        config.migrateLegacyPairingCode()

        XCTAssertEqual(config.pairingCode, "ABCD2345")
    }

    func testLocalDefaultsValidateWithoutFRPCredentials() throws {
        var config = LauncherConfig()
        XCTAssertFalse(config.allowLAN)
        XCTAssertFalse(config.hasExternalPublicURL)
        XCTAssertFalse(config.startOnAppLaunch)
        XCTAssertTrue(config.preventsSystemSleepWhileRunning)
        XCTAssertFalse(config.frpEnabled)
        XCTAssertEqual(config.appLanguage, .simplifiedChinese)
        config.normalize()
        XCTAssertEqual(config.preventSystemSleepWhileRunning, true)
        try config.validate(frpToken: "", gatewayToken: "", paths: .current())
    }

    func testLanguageRoundTripsWithoutBreakingLegacyConfigurations() throws {
        let legacy = "{\"pairingCode\":\"ABCDEFGH\",\"port\":4310,\"cdpPort\":9341,\"allowLAN\":false,\"startOnAppLaunch\":false,\"frpEnabled\":false,\"frpcPath\":\"\",\"frpServerAddress\":\"\",\"frpServerPort\":7000,\"frpClientID\":\"\",\"frpUser\":\"\",\"frpSubdomain\":\"\",\"frpServerName\":\"\",\"frpTrustedCAPath\":\"\",\"frpClientCertificatePath\":\"\",\"frpClientKeyPath\":\"\",\"publicURL\":\"\"}"
        let decodedLegacy = try JSONDecoder().decode(LauncherConfig.self, from: Data(legacy.utf8))
        XCTAssertEqual(decodedLegacy.appLanguage, .simplifiedChinese)
        XCTAssertTrue(decodedLegacy.preventsSystemSleepWhileRunning)
        XCTAssertFalse(String(decoding: try JSONEncoder().encode(decodedLegacy), as: UTF8.self).contains("publicURL"))

        var config = LauncherConfig()
        config.language = .english
        config.preventSystemSleepWhileRunning = false
        let decoded = try JSONDecoder().decode(LauncherConfig.self, from: JSONEncoder().encode(config))
        XCTAssertEqual(decoded.appLanguage, .english)
        XCTAssertFalse(decoded.preventsSystemSleepWhileRunning)
    }

    func testExternalHTTPSURLSupportsThirdPartyTunnels() throws {
        var config = LauncherConfig()
        config.externalPublicURL = "  https://device.example-tunnel.com/  "

        config.normalize()

        XCTAssertEqual(config.externalPublicURL, "https://device.example-tunnel.com/")
        XCTAssertTrue(config.hasExternalPublicURL)
        XCTAssertNoThrow(try config.validate(frpToken: "", gatewayToken: "", paths: .current()))

        let decoded = try JSONDecoder().decode(LauncherConfig.self, from: JSONEncoder().encode(config))
        XCTAssertEqual(decoded.externalPublicURL, config.externalPublicURL)
    }

    func testExternalTunnelRejectsNonHTTPSAndURLPaths() {
        for value in ["http://device.example.com", "https://device.example.com/control"] {
            var config = LauncherConfig()
            config.externalPublicURL = value
            XCTAssertThrowsError(try config.validate(frpToken: "", gatewayToken: "", paths: .current()))
        }
    }

    func testDesktopTranslationsResolveBothLanguages() {
        let value = BilingualText("已连接", "Connected")
        XCTAssertEqual(value.resolved(for: .simplifiedChinese), "已连接")
        XCTAssertEqual(value.resolved(for: .english), "Connected")
    }

    func testPortsMustBeDistinct() {
        var config = LauncherConfig()
        config.port = config.cdpPort
        XCTAssertThrowsError(try config.validate(frpToken: "", gatewayToken: "", paths: .current()))
    }

    func testFRPRequiresAValidServerConfiguration() {
        var config = LauncherConfig()
        config.frpEnabled = true
        XCTAssertThrowsError(try config.validate(
            frpToken: String(repeating: "a", count: 32),
            gatewayToken: String(repeating: "b", count: 32),
            paths: .current()
        ))
    }

    func testFRPCompatibilityModeDoesNotRequireCertificateFiles() throws {
        var config = LauncherConfig()
        config.frpEnabled = true
        config.frpServerAddress = "127.0.0.1"
        config.frpClientID = "device_01"
        config.frpUser = "account_01"
        config.frpSubdomain = "device-01"
        config.frpcPath = "/bin/echo"
        config.frpVerifyServerCertificate = false

        try config.validate(
            frpToken: String(repeating: "a", count: 32),
            gatewayToken: String(repeating: "b", count: 32),
            paths: .current()
        )
    }

    func testFRPTokensRequire8CharactersRatherThan32UTF8Bytes() throws {
        var config = LauncherConfig()
        config.frpEnabled = true
        config.frpServerAddress = "127.0.0.1"
        config.frpClientID = "device_01"
        config.frpUser = "account_01"
        config.frpSubdomain = "device-01"
        config.frpcPath = "/bin/echo"
        config.frpVerifyServerCertificate = false

        XCTAssertThrowsError(try config.validate(
            frpToken: String(repeating: "密", count: 7),
            gatewayToken: String(repeating: "钥", count: 8),
            paths: .current()
        ))
        XCTAssertNoThrow(try config.validate(
            frpToken: String(repeating: "密", count: 8),
            gatewayToken: String(repeating: "钥", count: 8),
            paths: .current()
        ))
    }

    func testLegacyConfigurationDefaultsToServerVerification() throws {
        let encoded = try JSONEncoder().encode(LauncherConfig())
        XCTAssertFalse(String(decoding: encoded, as: UTF8.self).contains("frpVerifyServerCertificate"))

        let decoded = try JSONDecoder().decode(LauncherConfig.self, from: encoded)
        XCTAssertTrue(decoded.verifiesFRPServerCertificate)
        XCTAssertNil(decoded.frpVerifyServerCertificate)
    }
}
