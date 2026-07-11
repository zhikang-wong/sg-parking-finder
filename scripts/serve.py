#!/usr/bin/env python3
"""Static file server for docs/ that avoids os.getcwd().

The Claude preview sandbox launches processes in a directory where getcwd()
raises EPERM, which breaks `python3 -m http.server`. Passing an absolute
`directory` to the handler sidesteps every getcwd call.
"""
import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

_here = os.path.dirname(os.path.abspath(__file__))
_candidates = [os.path.join(_here, "docs"),                     # serve.py next to docs/
               os.path.join(os.path.dirname(_here), "docs")]    # serve.py in scripts/
WEB = next(p for p in _candidates if os.path.isdir(p))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8642


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), partial(Handler, directory=WEB))
    print(f"serving {WEB} on http://127.0.0.1:{PORT}", flush=True)
    server.serve_forever()
