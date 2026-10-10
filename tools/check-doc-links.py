#!/usr/bin/env python3
"""Validate local HTML links, assets and static fragment identifiers."""
import os
import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit


class Page(HTMLParser):
    def __init__(self, text):
        super().__init__(convert_charrefs=True)
        self.ids = set()
        self.links = []
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        for key in ("id", "name"):
            if key in attrs:
                self.ids.add(attrs[key])
        for key in ("href", "src", "action"):
            if attrs.get(key):
                self.links.append(attrs[key])


def check(root):
    root = root.resolve()
    pages = {path: Page(path.read_text()) for path in root.rglob("*.html")}
    prefix = os.environ.get("DOCS_PATH_PREFIX", "/").rstrip("/")
    failures = []
    for path, page in pages.items():
        for link in page.links:
            parsed = urlsplit(link)
            if parsed.scheme or parsed.netloc:
                continue
            route = unquote(parsed.path)
            if route.startswith("/"):
                if prefix and not route.startswith(prefix + "/"):
                    failures.append(f"{path.relative_to(root)}: missing site prefix: {link}")
                    continue
                destination = root / route[len(prefix):].lstrip("/")
            else:
                destination = path.parent / route if route else path
            destination = destination.resolve()
            if destination.is_dir():
                destination /= "index.html"
            if not destination.is_relative_to(root) or not destination.exists():
                failures.append(f"{path.relative_to(root)}: missing target: {link}")
            elif parsed.fragment and destination in pages:
                ids = pages[destination].ids
                fragment = unquote(parsed.fragment)
                # rustdoc uses literal percent-encoded implementation IDs and
                # source line ranges handled by its highlighting JavaScript.
                line_range = re.fullmatch(r"(\d+)-(\d+)", fragment)
                valid_range = line_range and all(n in ids for n in line_range.groups())
                if fragment not in ids and parsed.fragment not in ids and not valid_range:
                    failures.append(f"{path.relative_to(root)}: missing anchor: {link}")
    if failures:
        raise SystemExit("\n".join(failures[:60]) + f"\n{len(failures)} broken local links")
    print(f"Links and fragments checked across {len(pages)} HTML pages.")


if __name__ == "__main__":
    check(Path(sys.argv[1]))
