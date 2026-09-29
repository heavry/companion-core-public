import XCTest
@testable import CompanionKit

final class CoreFirstStartupSequenceTests: XCTestCase {
    func testCredentialFailureDoesNotEraseSuccessfulCoreStartup() async {
        var events: [String] = []

        let result: CoreFirstStartupSequence.Result<String?> = await CoreFirstStartupSequence.run(
            startCore: {
                events.append("core")
                return true
            },
            restoreCredential: {
                events.append("credential")
                return nil
            }
        )

        XCTAssertEqual(events, ["core", "credential"])
        XCTAssertTrue(result.coreReady)
        XCTAssertNil(result.credential)
    }

    func testCredentialCacheCanBeUpdatedWithoutAnotherKeychainRead() {
        let cache = CredentialCache(initialValue: "first")
        XCTAssertEqual(cache.value, "first")
        cache.replace(with: "second")
        XCTAssertEqual(cache.value, "second")
        cache.replace(with: nil)
        XCTAssertFalse(cache.isConfigured)
    }
}
