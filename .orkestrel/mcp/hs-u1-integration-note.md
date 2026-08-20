# HS-U1 integration micro-edit

The parity gate on the HS-U1 tree failed one assertion: the guide documents
`DEFAULT_MCP_PROBE_TIMEOUT`, which HS-U1 deletes. The atomic-removal law updates every consumer
of a removed symbol in the same change, and the guide is a consumer, so the Orchestrator removes
exactly what the deletion makes false — the constants-table row and the cap clause — and nothing
else. The fuller prose rewrite (the pin contract, the worst case) stays with the examples-and-
guide unit, whose brief no longer carries these two lines. This edit is Orchestrator-written, so
the closing cross-engine audit names it as a claim.

Failing assertion, 2026-08-20: `tests/guides.test.ts > MCP > documents only barrel exports`,
`expected [ 'const DEFAULT_MCP_PROBE_TIMEOUT' ] to deeply equal []`.
