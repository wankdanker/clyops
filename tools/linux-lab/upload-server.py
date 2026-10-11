"""Real, guest-local HTTP PUT receiver for upload.sh. Nothing leaves the VM."""
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path

DIRECTORY = Path("/tmp/uploads")
DIRECTORY.mkdir(parents=True, exist_ok=True)


class Receiver(BaseHTTPRequestHandler):
    def do_PUT(self):
        if self.path != "/upload":
            self.send_error(404)
            return
        try:
            size = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            size = -1
        if not 0 <= size <= 8 * 1024 * 1024:
            self.send_error(413, "Provide Content-Length, up to 8 MiB")
            return
        body = self.rfile.read(size)
        if len(body) != size:
            self.send_error(400, "Incomplete upload")
            return
        digest = hashlib.sha256(body).hexdigest()
        target = DIRECTORY / (digest + ".bin")
        target.write_bytes(body)
        result = json.dumps({"received_bytes": len(body), "sha256": digest, "saved_to": str(target)}) + "\n"
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(result.encode())))
        self.end_headers()
        self.wfile.write(result.encode())


server = HTTPServer(("127.0.0.1", 9000), Receiver)
Path("/run/clyops-upload-ready").touch()
server.serve_forever()
