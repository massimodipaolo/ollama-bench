# DuckDuckGo MCP server for the web-search test: Docker's mcp/duckduckgo (nickclyde/duckduckgo-mcp-server 0.5.0, MIT),
# pinned by digest, with two changes so searches return results:
# 1. the optional "browser" backend (curl_cffi): DuckDuckGo answers the plain httpx client with HTTP 202 (a TLS
#    fingerprint block, empty results); the server's default "auto" backend then retries with curl_cffi;
# 2. curl_cffi impersonates Firefox instead of the hardcoded Chrome 131, which DuckDuckGo also blocks (checked
#    2026-11-27 from this host: chrome/chrome131 -> 202, firefox/safari -> 200 with results).
# Built by `pnpm datasets:fetch web-search` as ollama-bench-duckduckgo:<hash>.
FROM mcp/duckduckgo@sha256:5617c4c60f48f47556c0735de7a73f6abd731c132c65ec8c720b511819c9f88f
ARG IMPERSONATE=firefox
RUN pip install --no-cache-dir curl_cffi==0.17.0 \
    && f=$(python -c "import duckduckgo_mcp_server.server as s; print(s.__file__)") \
    && grep -q 'impersonate="chrome131"' "$f" \
    && sed -i "s/impersonate=\"chrome131\"/impersonate=\"${IMPERSONATE}\"/g" "$f" \
    && ! grep -q 'impersonate="chrome131"' "$f"
