#!/usr/bin/env python3
"""Local preview of the site *and* the admin, with no Cloudflare in the loop.

    python tools/devserver.py          # http://localhost:5502

Serves the built site and stands in for the admin Worker: /api/admin/* reads
and writes content/*.json on disk instead of committing to GitHub, and
re-runs the build after every save so the pages update immediately.

THIS HAS NO AUTHENTICATION. It binds to localhost only and is for trying
changes on your own machine before they go anywhere near the live site.
Real access control is Cloudflare Access in front of the deployed Worker.
"""

from __future__ import annotations

import base64
import json
import re
import subprocess
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTENT = ROOT / "content"
CONTENT_FILES = ["content/shared.json", "content/en.json", "content/zh.json"]

FAKE_USER = "you@localhost"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    # ------------------------------------------------------------ plumbing

    def log_message(self, fmt, *args):
        if "/api/" in (self.path or ""):
            sys.stderr.write(f"  {self.command} {self.path}\n")

    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length).decode("utf-8")) if length else {}

    def rebuild(self):
        result = subprocess.run(
            [sys.executable, str(ROOT / "build.py")],
            capture_output=True,
            text=True,
            cwd=ROOT,
        )
        if result.returncode != 0:
            sys.stderr.write(result.stdout + result.stderr)
        return result.returncode == 0

    # ------------------------------------------------------------ routes

    def do_GET(self):
        if self.path.startswith("/api/admin/"):
            route = self.path[len("/api/admin/"):].split("?")[0]

            if route == "status":
                return self.send_json({
                    "email": FAKE_USER,
                    "canPublish": True,
                    "liveBranch": "main (local)",
                    "draftBranch": "working copy",
                    "ahead": 0,
                    "behind": 0,
                    "unpublished": [],
                })

            if route == "content":
                files = {}
                for rel in CONTENT_FILES:
                    files[rel] = json.loads((ROOT / rel).read_text(encoding="utf-8"))
                return self.send_json({"headSha": "local", "files": files})

            return self.send_json({"error": f"No dev route for GET {route}"}, 404)

        return super().do_GET()

    def do_PUT(self):
        if self.path == "/api/admin/content":
            body = self.read_json()
            for rel, data in (body.get("files") or {}).items():
                if rel not in CONTENT_FILES:
                    return self.send_json({"error": f"Refusing to write {rel}"}, 400)
                (ROOT / rel).write_text(
                    json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                    newline="\n",
                )
            ok = self.rebuild()
            return self.send_json(
                {"ok": ok, "commit": "local"} if ok
                else {"error": "Saved, but the build failed — see the terminal"}, 200 if ok else 500
            )
        return self.send_json({"error": "Not found"}, 404)

    def do_POST(self):
        if self.path == "/api/admin/upload":
            body = self.read_json()
            path = body.get("path", "")
            if not re.fullmatch(r"(img|audio)/[A-Za-z0-9._/-]+", path) or ".." in path:
                return self.send_json({"error": "Bad upload path"}, 400)
            dest = ROOT / path
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(base64.b64decode(body.get("contentBase64", "")))
            return self.send_json({"ok": True, "commit": "local", "path": path})

        if self.path == "/api/admin/publish":
            self.rebuild()
            return self.send_json({"ok": True, "commit": "local"})

        # tools/groove.html posts here. The envelopes have to be produced by
        # an audio decoder and this machine has no ffmpeg and no Python one,
        # so the browser decodes and this route is only the pen that writes
        # the answer down. Dev-only, like everything else on /api/admin.
        if self.path == "/api/admin/groove":
            body = self.read_json()
            if not isinstance(body.get("tracks"), dict):
                return self.send_json({"error": "Bad groove payload"}, 400)
            dest = ROOT / "content" / "groove.json"
            dest.write_text(
                json.dumps(body, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8")
            self.rebuild()
            return self.send_json({"ok": True, "wrote": "content/groove.json",
                                   "tracks": len(body["tracks"])})

        return self.send_json({"error": "Not found"}, 404)


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5502
    subprocess.run([sys.executable, str(ROOT / "build.py")], cwd=ROOT)
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"\n  site   http://localhost:{port}/")
    print(f"  admin  http://localhost:{port}/admin/   (no auth — local only)\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
