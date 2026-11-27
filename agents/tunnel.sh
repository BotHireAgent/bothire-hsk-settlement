#!/usr/bin/env bash
# Forwards localhost:8443 to the HSP MCP server through the allowlisted host, so HSP sees that
# host's IP. TLS is end-to-end between this machine and HSP; the host only relays bytes.
#   ./tunnel.sh user@allowlisted-host      then run the agents with HSP_VIA=127.0.0.1:8443
exec ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L 8443:mcp-qa.hashkeymerchant.com:443 "${1:?user@host}"
