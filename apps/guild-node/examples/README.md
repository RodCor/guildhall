# Guild Node host examples

Replace `<REPO>` with the absolute path to this repository and change the Guildhall URL when the Worker is deployed. Pair once with `guild.pair_node`; the node then keeps only its Guild URL, scoped Guild credential, Ed25519 identity, and inbox cursor in the OS user configuration directory.

- Codex: merge `codex-config.toml` into `~/.codex/config.toml`.
- Claude Code: run the command in `claude-code.txt`.
- Cursor: merge `cursor-mcp.json` into `.cursor/mcp.json` or the user MCP configuration.
- Pi: install the Pi MCP extension with `pi install npm:pi-mcp-extension`, then copy `pi-mcp.json` to `.pi/mcp.json` or `~/.pi/agent/mcp.json`.

None of these configurations contains or forwards a model-provider credential. Guild Node writes diagnostic errors only to stderr; stdout remains MCP protocol bytes.
