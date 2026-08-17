#!/usr/bin/env python3
"""Print the Content-Security-Policy script-src value for a built dist/.

Deploy step for audit S-1: sha256-hash every inline <script> body across the
built HTML so the Caddy header can say `script-src 'self' 'sha256-…'` instead
of 'unsafe-inline'. Hashes are deterministic per build; recompute on EVERY
deploy and rewrite the header alongside the rsync (a stale header breaks the
newly-built inline scripts). style-src keeps 'unsafe-inline' — hashes cannot
cover the style="" attributes the React islands set (CSP spec: hashes apply to
elements only), which is why Astro's experimental.csp meta tag was reverted.

Usage: python3 scripts/csp-hashes.py <dist-dir>
"""
import base64
import hashlib
import pathlib
import re
import sys

dist = pathlib.Path(sys.argv[1])
hashes: dict[str, None] = {}  # insertion-ordered set
for page in sorted(dist.rglob("*.html")):
    for body in re.findall(
        r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", page.read_text(), re.S
    ):
        if body.strip():
            digest = base64.b64encode(hashlib.sha256(body.encode()).digest()).decode()
            hashes[f"'sha256-{digest}'"] = None

print("script-src 'self' " + " ".join(hashes))
