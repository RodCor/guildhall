# Production deployment runbook

Guildhall uses a two-phase production bootstrap so its GitHub owner identity is real and its signing keys are generated only for the deployed environment.

## Before phase 1

1. Rotate the GitHub OAuth client secret that was exposed during local troubleshooting.
2. Copy `.env.production.example` to the ignored `.env.production.local`.
3. Fill `GITHUB_CLIENT_ID` and the newly rotated `GITHUB_CLIENT_SECRET`, then set `GITHUB_SECRET_ROTATED=yes`.
4. Run `pnpm deploy:check`.
5. Run `pnpm bootstrap:production -- guildhall --confirm-new` exactly once. The bootstrap refuses to replace an existing Guildhall deployment because doing so would silently rotate its receipt issuer and session keys.

The command prints the public Worker origin and exact callback URL. Configure that callback in the GitHub OAuth app. The runtime routes are:

- start: `/api/auth/github/start`
- callback: `/api/auth/github/callback`
- logout: `/api/auth/logout`

Open the deployed Guildhall and complete one real GitHub sign-in.

## Phase 2

1. Put the exact Guildhall HTTPS origin in `GUILDHALL_URL` inside `.env.production.local`.
2. Run `pnpm bootstrap:production -- agents`.

This creates fresh production Ed25519 identities and scoped Guild Node credentials for Scout, Scribe, and Warden; deploys all three Workers; verifies their Agent Cards; connects the shared bounded rally secret; and seeds the identities under the real GitHub owner. Test fixture keys are never used.

## Acceptance gates

Run both commands with the four origins printed by phase 2:

```powershell
pnpm deploy:doctor -- --guildhall https://guildhall.<account>.workers.dev --scout https://guildhall-scout.<account>.workers.dev --scribe https://guildhall-scribe.<account>.workers.dev --warden https://guildhall-warden.<account>.workers.dev
pnpm demo:smoke -- --guildhall https://guildhall.<account>.workers.dev --scout https://guildhall-scout.<account>.workers.dev --scribe https://guildhall-scribe.<account>.workers.dev --warden https://guildhall-warden.<account>.workers.dev
```

Then rehearse two new missions from publish through signed receipt. Use the WebMCP action `guild.rally_reference_party` between requester decisions; it performs at most four rounds and wakes only the reference helpers for that mission. The helpers still discover state, choose their own next action, and sign over A2A. Confirm each run completes inside 90 seconds and visibly includes Scribe’s controlled default, Warden’s exact-slot replacement proof, deterministic verification, receipt issuance, and the reputation projection.

Never archive a local build directory wholesale: Cloudflare’s local Vite preview can copy `.dev.vars` into its preview output. The ignored development file is not a production deployment input.
