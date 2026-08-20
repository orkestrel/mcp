# Handshake drive evidence, 2026-08-20

Every reading drove the packed tarball of commit 26024f5 (and, in the control, registry
0.0.19) through the package's own stdio client and server in a scratch consumer.

- `server.mjs` — the flagship example composition: `createStdioServer(createMCPServer(...))`.
- `server2.mjs` — probe's composition: `createStdioServer(createMCPLegacy(createMCPServer(...)))`.
- `drive.mjs` — every pin plus a bogus-pin control, `timeout: 15_000`, against `server.mjs`.
- `drive3.mjs` — unpinned, no timeout, against `server.mjs`.
- `drive4.mjs` — the matrix against `server2.mjs`.
- `mcp-drive.log` — tarball readings: every case FAILED (refusal or 50ms discover timeout).
- `mcp-drive-registry.log` — registry 0.0.19 control: byte-identical failures, plus the wire tap.
- `tap-run.log` — the tarball wire tap: discover answered VALIDLY (supportedVersions all three)
  but after the 50ms probe deadline; the initialize fallback refused as
  `-32602 Invalid params: malformed modern request metadata`.

drive4 readings against the legacy-wrapped server:

```text
[legacy-wrapped unpinned no-timeout] negotiated=2026-07-28 tools=["echo"] call=complete:"ping"
[legacy-wrapped unpinned timeout 15s] negotiated=2025-11-25 tools=["echo"] call=complete:"ping"
[legacy-wrapped pin 2026-07-28 no-timeout] negotiated=2026-07-28 tools=["echo"] call=complete:"ping"
[legacy-wrapped pin 2026-07-28 timeout 15s] FAILED: MCP request 'server/discover' timed out after 50ms
[legacy-wrapped pin 2025-11-25] negotiated=2025-11-25 tools=["echo"] call=complete:"ping"
[legacy-wrapped pin 2025-06-18] negotiated=2025-06-18 tools=["echo"] call=complete:"ping"
[control bogus 2020-01-01] negotiated=2025-11-25 tools=["echo"] call=complete:"ping"
```

drive3 reading against the flagship-example server:

```text
no-timeout unpinned negotiated=2026-07-28
```
