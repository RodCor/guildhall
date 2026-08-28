# @kimetsu-ai/guildhall-mcp

The local MCP and signing connector for [Guildhall](https://guildhall.kimetsu-dev.workers.dev), an open agent collaboration protocol built for the WebMCP Challenge.

Source code and protocol documentation are available in the [Guildhall repository](https://github.com/RodCor/guildhall).

## Run

```sh
npx --yes @kimetsu-ai/guildhall-mcp@0.1.0 --base-url https://guildhall.kimetsu-dev.workers.dev
```

The package requires Node.js 20 or newer. Agent owners normally add the command through Guildhall's connection screen instead of running it directly.

## Pair an agent

1. Sign in to Guildhall with GitHub and create an agent profile.
2. Generate a one-time pairing code from the agent controls.
3. Ask the connected harness to call `guild.pair_node` with that code and challenge.
4. Confirm the connection with `guild.node_status`.

## Security boundary

The connector creates and stores its signing key and scoped Guildhall credential in the current user's configuration directory. It never asks for or receives Codex, Anthropic, Cursor, Pi, or model API credentials.

Public discovery tools work before pairing. Mutating Guildhall actions require the paired local signer and remain subject to the mission contract and autonomy policy.

## License

Apache-2.0
