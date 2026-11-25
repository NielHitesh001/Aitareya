import Darwin
import Foundation
import XCTest
@testable import CtxCompanion

private func withUnixSocketServer(
    chunks: [Data],
    delayMicroseconds: useconds_t = 15_000,
    run: (String) async throws -> Void
) async throws {
    let socketPath = "/tmp/ctx-sock-\(UUID().uuidString.prefix(8)).sock"
    unlink(socketPath)
    defer { unlink(socketPath) }

    let listenFD = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    XCTAssertGreaterThanOrEqual(listenFD, 0)
    defer { Darwin.close(listenFD) }

    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let pathBytes = socketPath.utf8CString
    XCTAssertLessThan(pathBytes.count, MemoryLayout.size(ofValue: addr.sun_path))
    withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
        ptr.withMemoryRebound(to: CChar.self, capacity: pathBytes.count) { dest in
            pathBytes.withUnsafeBufferPointer { src in
                _ = memcpy(dest, src.baseAddress!, src.count)
            }
        }
    }

    let bindRes = withUnsafePointer(to: &addr) { ptr in
        ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
            Darwin.bind(listenFD, sockPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    XCTAssertEqual(bindRes, 0)
    XCTAssertEqual(Darwin.listen(listenFD, 4), 0)

    let serverTask = Task.detached {
        let clientFD = Darwin.accept(listenFD, nil, nil)
        if clientFD >= 0 {
            var reqBuf = [UInt8](repeating: 0, count: 4096)
            while true {
                let n = Darwin.read(clientFD, &reqBuf, reqBuf.count)
                if n <= 0 || reqBuf[0..<n].contains(UInt8(ascii: "\n")) { break }
            }
            for (index, chunk) in chunks.enumerated() {
                if index > 0 && delayMicroseconds > 0 {
                    usleep(delayMicroseconds)
                }
                chunk.withUnsafeBytes { raw in
                    if let base = raw.baseAddress {
                        _ = Darwin.write(clientFD, base, chunk.count)
                    }
                }
            }
            Darwin.shutdown(clientFD, SHUT_WR)
            usleep(10_000)
            Darwin.close(clientFD)
        }
    }

    try await run(socketPath)
    await serverTask.value
}

final class SocketClientFramingTests: XCTestCase {
    func testResponseSplitAcrossThreeChunksDecodesCorrectly() async throws {
        let padding = String(repeating: "a", count: 8000)
        let json = #"{"v":1,"id":"1","ok":true,"result":{"repos":[{"name":"owner/repo","path":"/Users/test/code/github/owner/repo","branch":"main","state":"upToDate","ahead":0,"behind":0,"dirty":false,"lastFetch":null,"prState":"none"}],"counts":{"upToDate":1,"behind":0,"ahead":0,"diverged":0,"dirty":0,"missing":0},"lastSuccessfulPoll":null},"note":"\#(padding)"}"# + "\n"
        let fullData = Data(json.utf8)
        let split1 = fullData.count / 3
        let split2 = (fullData.count * 2) / 3
        let chunks = [
            fullData.subdata(in: 0..<split1),
            fullData.subdata(in: split1..<split2),
            fullData.subdata(in: split2..<fullData.count),
        ]

        try await withUnixSocketServer(chunks: chunks) { socketPath in
            let client = UnixSocketClient(socketPath: socketPath)
            let result = try await client.reposStatus()
            XCTAssertEqual(result.repos.count, 1)
            XCTAssertEqual(result.repos.first?.name, "owner/repo")
            XCTAssertEqual(result.counts.upToDate, 1)
        }
    }

    func testResponseWithNoNewlineBeforeCloseReturnsInvalidResponse() async throws {
        let jsonWithoutNewline = #"{"v":1,"id":"1","ok":true,"result":{"state":"healthy","lastPollAt":null,"allowlistedRepoCount":0,"pendingApprovalCount":0,"errorCount":0}}"#
        let chunks = [Data(jsonWithoutNewline.utf8)]

        try await withUnixSocketServer(chunks: chunks, delayMicroseconds: 0) { socketPath in
            let client = UnixSocketClient(socketPath: socketPath)
            do {
                _ = try await client.status()
                XCTFail("Expected SocketClientError.invalidResponse")
            } catch let error as SocketClientError {
                XCTAssertEqual(error, .invalidResponse)
            }
        }
    }

    func testNormalSmallResponseStillDecodes() async throws {
        let json = #"{"v":1,"id":"1","ok":true,"result":{"state":"healthy","lastPollAt":null,"allowlistedRepoCount":2,"pendingApprovalCount":1,"errorCount":0}}"# + "\n"
        let chunks = [Data(json.utf8)]

        try await withUnixSocketServer(chunks: chunks, delayMicroseconds: 0) { socketPath in
            let client = UnixSocketClient(socketPath: socketPath)
            let result = try await client.status()
            XCTAssertEqual(result.state, .healthy)
            XCTAssertEqual(result.allowlistedRepoCount, 2)
            XCTAssertEqual(result.pendingApprovalCount, 1)
        }
    }
}
