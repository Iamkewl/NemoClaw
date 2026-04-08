#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""
URL-decoding HTTP proxy for OpenShell placeholder rewriting.

Python HTTP clients (httpx) URL-encode colons in URL paths, turning
openshell:resolve:env:TOKEN into openshell%3Aresolve%3Aenv%3ATOKEN.
OpenShell's L7 proxy doesn't recognize the encoded form.

This proxy sits between the Python process and the OpenShell proxy,
URL-decodes the CONNECT target and request paths so the placeholders
are restored before reaching the L7 proxy.

Usage: Launched by start.sh, listens on 127.0.0.1:3129.
       HTTPS_PROXY=http://127.0.0.1:3129 hermes gateway run
"""

import asyncio
import sys
from urllib.parse import unquote


UPSTREAM_HOST = "10.200.0.1"
UPSTREAM_PORT = 3128
LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 3129


async def handle_client(reader, writer):
    """Proxy a single connection, URL-decoding the initial request line."""
    try:
        first_line = await asyncio.wait_for(reader.readline(), timeout=10)
        if not first_line:
            writer.close()
            return

        # Decode the request line (e.g. CONNECT api.telegram.org:443 HTTP/1.1)
        # or GET /botopenshell%3Aresolve%3Aenv%3ATOKEN/getMe HTTP/1.1
        decoded_line = unquote(first_line.decode("utf-8", errors="replace")).encode(
            "utf-8"
        )

        # Read remaining headers
        headers = bytearray(decoded_line)
        while True:
            line = await asyncio.wait_for(reader.readline(), timeout=10)
            headers.extend(line)
            if line == b"\r\n" or line == b"\n" or not line:
                break

        # Connect to upstream proxy
        up_reader, up_writer = await asyncio.open_connection(
            UPSTREAM_HOST, UPSTREAM_PORT
        )
        up_writer.write(bytes(headers))
        await up_writer.drain()

        # Bidirectional relay
        await asyncio.gather(
            _relay(reader, up_writer),
            _relay(up_reader, writer),
        )
    except (asyncio.TimeoutError, ConnectionError, OSError):
        pass
    finally:
        writer.close()


async def _relay(src, dst):
    """Copy data from src to dst until EOF."""
    try:
        while True:
            data = await src.read(65536)
            if not data:
                break
            dst.write(data)
            await dst.drain()
    except (ConnectionError, OSError):
        pass


async def main():
    server = await asyncio.start_server(handle_client, LISTEN_HOST, LISTEN_PORT)
    print(
        f"[decode-proxy] Listening on {LISTEN_HOST}:{LISTEN_PORT} -> {UPSTREAM_HOST}:{UPSTREAM_PORT}",
        file=sys.stderr,
    )
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
