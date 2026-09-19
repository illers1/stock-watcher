// Stock Watcher for the Mac: a native window around the local server.
//
// The app is the same pages and the same server.py the website runs on,
// packaged so it needs neither Netlify nor a browser. On launch it starts
// server.py as a child process, waits for it to answer, and shows the pages in
// a native window. Quitting stops the server.
//
// The port is fixed rather than picked fresh each time because the watchlist
// lives in the page's local storage, which belongs to one origin: a different
// port every launch would open to an empty watchlist every launch.
//
// Built by desktop/mac/build.sh; there is no Xcode project.

import AppKit
import CoreImage
import WebKit

let port = 8790
let home = URL(string: "http://127.0.0.1:\(port)/index.html")!

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var server: Process?
    var sharing = false
    var shareItem: NSMenuItem!
    var shareWindow: NSWindow?

    let fm = FileManager.default
    var bundled: URL { Bundle.main.resourceURL!.appendingPathComponent("app") }
    var supportDir: URL {
        fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Stock Watcher")
    }
    var logURL: URL {
        fm.urls(for: .libraryDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Logs/Stock Watcher.log")
    }

    // MARK: - Launch and quit

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        buildWindow()
        startServer(shared: false) { ok in
            if ok { self.webView.load(URLRequest(url: home)) } else { self.failToStart() }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ note: Notification) { stopServer() }

    // MARK: - The server

    /// The first Python 3 on this Mac. /usr/bin/python3 is always present; if
    /// the developer tools are missing, running it offers to install them.
    func python() -> String {
        for path in ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]
        where fm.isExecutableFile(atPath: path) { return path }
        return "/usr/bin/python3"
    }

    func startServer(shared: Bool, then done: @escaping (Bool) -> Void) {
        stopServer()
        stopStrayServer()
        try? fm.createDirectory(at: supportDir, withIntermediateDirectories: true)
        try? fm.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !fm.fileExists(atPath: logURL.path) { fm.createFile(atPath: logURL.path, contents: nil) }
        let log = try? FileHandle(forWritingTo: logURL)
        log?.seekToEndOfFile()

        let p = Process()
        p.executableURL = URL(fileURLWithPath: python())
        // -u: unbuffered, so the log holds what happened even if the server is killed.
        p.arguments = ["-u", bundled.appendingPathComponent("server.py").path, "--no-open", "--exit-with-parent",
                       "--port", String(port), "--host", shared ? "0.0.0.0" : "127.0.0.1"]
        var env = ProcessInfo.processInfo.environment
        env["STOCK_WATCHER_DATA"] = supportDir.path
        p.environment = env
        p.standardOutput = log
        p.standardError = log
        do { try p.run() } catch { done(false); return }
        server = p
        sharing = shared
        updateShareItem()
        waitForServer(attempts: 120, then: done)
    }

    /// Polls until the server answers as Stock Watcher, or gives up.
    func waitForServer(attempts: Int, then done: @escaping (Bool) -> Void) {
        guard attempts > 0, server?.isRunning == true else { done(false); return }
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/manifest.webmanifest")!)
        req.timeoutInterval = 0.5
        URLSession.shared.dataTask(with: req) { data, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200 &&
                String(data: data ?? Data(), encoding: .utf8)?.contains("Stock Watcher") == true
            DispatchQueue.main.asyncAfter(deadline: .now() + (ok ? 0 : 0.15)) {
                if ok { done(true) } else { self.waitForServer(attempts: attempts - 1, then: done) }
            }
        }.resume()
    }

    func stopServer() {
        guard let p = server else { return }
        if p.isRunning {
            p.terminate()
            p.waitUntilExit()
        }
        server = nil
    }

    /// A server of ours left behind by an earlier run that did not quit
    /// cleanly. Only a process running this app's server.py is stopped;
    /// anything else holding the port is left alone and reported instead.
    func stopStrayServer() {
        for pid in run("/usr/sbin/lsof", ["-ti", "tcp:\(port)", "-sTCP:LISTEN"])
            .split(separator: "\n").compactMap({ Int32($0) }) {
            let command = run("/bin/ps", ["-o", "command=", "-p", String(pid)])
            if command.contains("server.py") && command.contains("--port \(port)") {
                kill(pid, SIGTERM)
                usleep(300_000)
            }
        }
    }

    func run(_ tool: String, _ args: [String]) -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = args
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return "" }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(data: data, encoding: .utf8) ?? ""
    }

    func failToStart() {
        let alert = NSAlert()
        alert.messageText = "Stock Watcher could not start"
        alert.informativeText = """
            Its local server did not come up. The usual causes are that Python 3 is not \
            installed yet — macOS offers to install it the first time it is needed — or that \
            another program is using port \(port).

            Details are in ~/Library/Logs/Stock Watcher.log.
            """
        alert.addButton(withTitle: "Quit")
        alert.runModal()
        NSApp.terminate(nil)
    }

    // MARK: - The window

    func buildWindow() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()   // keeps the watchlist between launches
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.setValue(false, forKey: "drawsBackground")

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Stock Watcher"
        window.contentView = webView
        window.minSize = NSSize(width: 420, height: 480)
        window.setFrameAutosaveName("StockWatcherMain")
        if !window.setFrameUsingName("StockWatcherMain") { window.center() }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func isLocal(_ url: URL) -> Bool {
        url.host == "127.0.0.1" || url.host == "localhost" || url.scheme == "about"
    }

    // Links out — news articles, SEC filings — open in the normal browser.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, !isLocal(url) {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if isLocal(url) { webView.load(action.request) } else { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        window.title = webView.title?.isEmpty == false ? webView.title! : "Stock Watcher"
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

    // The pages use confirm() and prompt(); a web view drops them unless asked.
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) {
            completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil)
        }
    }

    // MARK: - Opening it on a phone

    /// While sharing, the server listens on the network as well, so a phone on
    /// the same Wi-Fi can open it. Off by default, and off again on quit.
    @objc func toggleSharing(_ sender: Any?) {
        if sharing {
            startServer(shared: false) { _ in self.webView.reload() }
            shareWindow?.close()
            return
        }
        let alert = NSAlert()
        alert.messageText = "Open Stock Watcher on your phone?"
        alert.informativeText = """
            Your phone can use Stock Watcher from this Mac while both are on the same Wi-Fi \
            and the Mac is awake.

            While this is on, anyone on this network can reach it, so only turn it on at home \
            or on another network you trust. It turns off when you quit. macOS may ask whether \
            python3 can accept incoming connections — allow it.
            """
        alert.addButton(withTitle: "Turn On")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        startServer(shared: true) { ok in
            if ok { self.webView.reload(); self.showPhoneWindow() } else { self.failToStart() }
        }
    }

    func updateShareItem() {
        shareItem?.title = sharing ? "Stop Sharing with Phone" : "Open on Phone…"
    }

    /// This Mac's address on the local network.
    func lanAddress() -> String? {
        var best: String?
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return nil }
        defer { freeifaddrs(list) }
        for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let ifa = ptr.pointee
            guard let addr = ifa.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET),
                  (ifa.ifa_flags & UInt32(IFF_UP)) != 0, (ifa.ifa_flags & UInt32(IFF_LOOPBACK)) == 0
            else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            getnameinfo(addr, socklen_t(addr.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST)
            let ip = String(cString: host)
            let name = String(cString: ifa.ifa_name)
            if name == "en0" { return ip }          // Wi-Fi on most Macs
            if best == nil, name.hasPrefix("en") { best = ip }
        }
        return best
    }

    func qrImage(_ text: String) -> NSImage? {
        guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(Data(text.utf8), forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 9, y: 9)) else { return nil }
        let rep = NSCIImageRep(ciImage: output)
        let image = NSImage(size: rep.size)
        image.addRepresentation(rep)
        return image
    }

    func showPhoneWindow() {
        guard let ip = lanAddress() else {
            let alert = NSAlert()
            alert.messageText = "This Mac is not on a network"
            alert.informativeText = "Connect to Wi-Fi, then try again."
            alert.runModal()
            startServer(shared: false) { _ in self.webView.reload() }
            return
        }
        let url = "http://\(ip):\(port)/index.html"
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 380, height: 500),
                         styleMask: [.titled, .closable], backing: .buffered, defer: false)
        w.title = "Open on Phone"
        w.isReleasedWhenClosed = false

        let qr = NSImageView(image: qrImage(url) ?? NSImage())
        qr.imageScaling = .scaleProportionallyUpOrDown
        let link = NSTextField(labelWithString: url)
        link.isSelectable = true
        link.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        let steps = NSTextField(wrappingLabelWithString: """
            1. Point your phone's camera at the code and open the link.
            2. iPhone: tap Share, then Add to Home Screen. Android: menu, then Add to Home screen.
            3. It opens like an app from then on, whenever this Mac is awake and on the same Wi-Fi.
            """)
        steps.font = .systemFont(ofSize: 12)
        let stack = NSStackView(views: [qr, link, steps])
        stack.orientation = .vertical
        stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: 18, left: 20, bottom: 18, right: 20)
        qr.heightAnchor.constraint(equalToConstant: 280).isActive = true
        qr.widthAnchor.constraint(equalToConstant: 280).isActive = true
        w.contentView = stack
        w.center()
        w.makeKeyAndOrderFront(nil)
        shareWindow = w
    }

    // MARK: - Menus

    @objc func go(_ sender: NSMenuItem) {
        if let path = sender.representedObject as? String,
           let url = URL(string: "http://127.0.0.1:\(port)/\(path)") {
            webView.load(URLRequest(url: url))
        }
    }
    @objc func reload(_ sender: Any?) { webView.reload() }
    @objc func back(_ sender: Any?) { webView.goBack() }
    @objc func forward(_ sender: Any?) { webView.goForward() }
    @objc func zoomIn(_ sender: Any?) { webView.pageZoom = min(webView.pageZoom + 0.1, 2.0) }
    @objc func zoomOut(_ sender: Any?) { webView.pageZoom = max(webView.pageZoom - 0.1, 0.6) }
    @objc func actualSize(_ sender: Any?) { webView.pageZoom = 1.0 }
    @objc func showLog(_ sender: Any?) { NSWorkspace.shared.open(logURL) }

    func buildMenu() {
        let main = NSMenu()
        func add(_ title: String, _ items: [NSMenuItem]) {
            let holder = NSMenuItem()
            let menu = NSMenu(title: title)
            items.forEach(menu.addItem)
            holder.submenu = menu
            main.addItem(holder)
        }
        func item(_ title: String, _ action: Selector?, _ key: String = "",
                  _ mods: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            i.target = target
            return i
        }

        shareItem = item("Open on Phone…", #selector(toggleSharing(_:)), target: self)
        let hideOthers = item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option])
        add("Stock Watcher", [
            item("About Stock Watcher", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
            .separator(),
            shareItem,
            .separator(),
            item("Hide Stock Watcher", #selector(NSApplication.hide(_:)), "h"),
            hideOthers,
            item("Show All", #selector(NSApplication.unhideAllApplications(_:)), ""),
            .separator(),
            item("Quit Stock Watcher", #selector(NSApplication.terminate(_:)), "q"),
        ])
        add("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])
        add("View", [
            item("Reload", #selector(reload(_:)), "r", target: self),
            .separator(),
            item("Actual Size", #selector(actualSize(_:)), "0", target: self),
            item("Zoom In", #selector(zoomIn(_:)), "+", target: self),
            item("Zoom Out", #selector(zoomOut(_:)), "-", target: self),
            .separator(),
            item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        let pages: [(String, String)] = [
            ("Watchlist", "index.html"), ("Movers", "movers.html"), ("Earnings", "earnings.html"),
            ("Catalysts", "catalysts.html"), ("Insiders", "insiders.html"), ("Shorts", "shorts.html"),
            ("Group", "group.html"),
        ]
        var goItems = pages.enumerated().map { n, page -> NSMenuItem in
            let i = item(page.0, #selector(go(_:)), String(n + 1), target: self)
            i.representedObject = page.1
            return i
        }
        goItems += [.separator(),
                    item("Back", #selector(back(_:)), "[", target: self),
                    item("Forward", #selector(forward(_:)), "]", target: self)]
        add("Go", goItems)
        add("Window", [
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Zoom", #selector(NSWindow.performZoom(_:)), ""),
            .separator(),
            item("Close", #selector(NSWindow.performClose(_:)), "w"),
        ])
        add("Help", [item("Show Server Log", #selector(showLog(_:)), "", target: self)])
        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
