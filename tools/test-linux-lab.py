#!/usr/bin/env python3
"""Exercise failed BIOS downloads without depending on external network health."""
import hashlib
import http.client
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import call, patch
import urllib.error

spec = importlib.util.spec_from_file_location("lab", Path(__file__).with_name("build-linux-lab.py"))
lab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lab)

DATA = b"verified BIOS bytes"
CHECKSUM = hashlib.sha256(DATA).hexdigest()
URL = "https://example.test/pinned/bios.bin"


class DownloadTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.cached = Path(directory.name) / "bios.bin"
        self.urlopen = self.enterContext(patch.object(lab.urllib.request, "urlopen"))
        self.sleep = self.enterContext(patch.object(lab.time, "sleep"))

    def test_connection_reset_truncated_read_and_server_error_are_retried(self):
        class Truncated(io.BytesIO):
            def read(self):
                raise http.client.IncompleteRead(b"partial", 100)
        self.urlopen.side_effect = [
            urllib.error.URLError(ConnectionResetError(104, "Connection reset by peer")),
            Truncated(b"partial"),
            urllib.error.HTTPError(URL, 503, "Unavailable", {}, None),
            io.BytesIO(DATA),
        ]
        self.assertEqual(lab.download_verified(URL, self.cached, CHECKSUM), DATA)
        self.assertEqual(self.cached.read_bytes(), DATA)
        self.assertEqual(self.sleep.call_args_list, [call(1), call(2), call(4)])
        self.assertEqual(list(self.cached.parent.iterdir()), [self.cached])

    def test_valid_cache_needs_no_network(self):
        self.cached.write_bytes(DATA)
        self.assertEqual(lab.download_verified(URL, self.cached, CHECKSUM), DATA)
        self.urlopen.assert_not_called()

    def test_invalid_cache_is_replaced_with_verified_download(self):
        self.cached.write_bytes(b"partial old download")
        self.urlopen.return_value = io.BytesIO(DATA)
        self.assertEqual(lab.download_verified(URL, self.cached, CHECKSUM), DATA)
        self.assertEqual(self.cached.read_bytes(), DATA)

    def test_bad_checksum_is_never_cached(self):
        self.urlopen.return_value = io.BytesIO(b"wrong BIOS")
        with self.assertRaisesRegex(ValueError, "Invalid checksum"):
            lab.download_verified(URL, self.cached, CHECKSUM)
        self.assertEqual(list(self.cached.parent.iterdir()), [])

    def test_permanent_http_error_is_not_retried(self):
        self.urlopen.side_effect = urllib.error.HTTPError(URL, 404, "Not found", {}, None)
        with self.assertRaises(urllib.error.HTTPError):
            lab.download_verified(URL, self.cached, CHECKSUM)
        self.sleep.assert_not_called()
        self.assertFalse(self.cached.exists())

    def test_retries_are_bounded_and_do_not_leave_partial_cache_files(self):
        self.urlopen.side_effect = urllib.error.URLError("connection reset")
        with self.assertRaisesRegex(RuntimeError, "after 4 attempts"):
            lab.download_verified(URL, self.cached, CHECKSUM)
        self.assertEqual(self.urlopen.call_count, 4)
        self.assertEqual(list(self.cached.parent.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
