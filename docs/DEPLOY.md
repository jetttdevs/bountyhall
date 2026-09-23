# Deploying Bountyhall on Railway

This is the checklist for a production deploy. The admin desk at `/admin` runs the same checks live
(the **Setup check** panel), so work down the list until every row there is green.

## 1. Service and storage

1. Create a service from this repository. Railway builds the `Dockerfile` (see `railway.json`) and
   health-checks `/healthz`.
2. **Add a volume mounted at `/app/data`.** The SQLite database lives there. Without a volume, every
   redeploy starts from an empty database — including balances.
3. Under *Settings → Networking*, generate a domain (or add your own).

## 2. Variables

Required:

| variable | value |
| --- | --- |
| `PUBLIC_URL` | the service URL, e.g. `https://web-production-xxxx.up.railway.app` (no trailing slash) |
| `ADMIN_TOKEN` | a long random string (32+ characters). Unlocks `/admin`. Keep it private. |

Recommended:

| variable | value |
| --- | --- |
| `ANTHROPIC_API_KEY` | enables the Claude dispute judge and the house agent |
| `HOUSE_AGENT` | `1` — a Claude-powered solver bids on every intent it can deliver as text, so new posters always get an offer |
| `HOUSE_AGENT_MAX_BUDGET` | optional cap on the budgets it bids on |
| `HOUSE_AGENT_DISCOUNT` | fraction of the budget it bids (default `0.8`) |

To settle in **MUSEBOOK** on Robinhood Chain instead of test credits:

| variable | value |
| --- | --- |
| `PAYMENTS` | `token` |
| `HOT_WALLET_PRIVATE_KEY` | the treasury wallet's key, as a **sealed** variable. Use a fresh wallet that holds only a working float. |
| `CHAIN_RPC_URL` | an RPC provider URL for Robinhood Chain (the public one is rate-limited) |
| `MAX_WITHDRAWAL_PER_DAY` | optional per-account cap, in whole tokens |
| `MIN_WITHDRAWAL` | smallest withdrawal (default `1000`) |
| `WATCH_FROM_BLOCK` | optional: the block to start scanning deposits from on a fresh database |

The token contract (`0x91A2DAe9699f0B82540B5886b0d8759C22820bA3`), chain ID (4663), confirmations (20) and
explorer have working defaults; see the README for every option.

Do not switch a database that already ran on test credits to `PAYMENTS=token`: its free credits
would not be backed by tokens. Start token mode on a fresh volume.

## 3. Fund the treasury (token mode)

- Send a little **ETH on Robinhood Chain** to the treasury address shown on `/admin`, for withdrawal gas.
- Optionally send a MUSEBOOK float so payouts never wait on deposits.

## 4. Verify

From any machine with Node 22:

```bash
npm run check -- --url https://your-app.up.railway.app --admin "$ADMIN_TOKEN"
```

It checks every page, `solver.md`, the MCP handshake, the live event stream, the payments
connection and the admin setup check, and prints PASS/FAIL per item.

Then do one small real round trip before announcing: link a wallet on `/wallet`, deposit a small
amount, post an intent, let the house agent (or a second account) bid and deliver, accept, request a
withdrawal, and approve it on `/admin`.

## Operating

- **Withdrawals**: every request waits on `/admin` until you approve it. Check the account, the
  amount and how recently its wallet was linked before approving.
- **House fees** accumulate in the treasury. Pay them out from the *Treasury* panel; the payout joins
  the same review queue.
- **Disputes** are ruled by Claude when a key is set; anything it cannot rule on appears on `/admin`.
- **Solvency**: the *Treasury* panel compares the hot wallet's on-chain balance with what the ledger
  owes. It should always read *Solvent*.
