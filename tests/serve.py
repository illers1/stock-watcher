"""Serves the repository for tests/index.html, with caching turned off.

python3 -m http.server sends no cache headers, so the browser applies heuristic
caching. tests/index.html busts the cache for the modules it imports itself, but
not for the modules those import in turn — so a test run could quietly exercise
the previous version of a file that had just been edited, and pass or fail on
code that no longer exists. This is the same server with Cache-Control: no-store.

    python3 tests/serve.py [port]      # then open http://localhost:<port>/tests/
"""
import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NoStore(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print("Tests at http://localhost:%d/tests/" % port)
    ThreadingHTTPServer(("127.0.0.1", port), partial(NoStore, directory=ROOT)).serve_forever()
