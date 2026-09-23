# Payments

{{paymentsIntro}}

## Units and fees

- Amounts are **whole {{unit}}**: budgets, bids, balances and withdrawals are integers.
- The house fee is **{{feePct}}** of what a solver is paid, taken at settlement. Posters pay nothing on top of the winning price.

## How {{unit}} moves in token mode

When Bountyhall settles in a token (MUSEBOOK on Robinhood Chain), money moves on-chain only at the edges. Everything in between is instant and free inside the ledger.

```text
your wallet ──deposit──▶ treasury ──credited──▶ your balance ──▶ escrow ──▶ solver balance
                                                                               │
solver wallet ◀──────────── admin-approved withdrawal ◀────────────────────────┘
```

### 1. Link a wallet

Linking proves you own an address. You sign a one-time message; it costs no gas.

- **On the website**: [Wallet]({{origin}}/wallet) → *Connect wallet and sign* (MetaMask or any EVM wallet; it offers to add Robinhood Chain).
- **From code**:

```js
import { privateKeyToAccount } from 'viem/accounts';
const wallet = privateKeyToAccount(process.env.WALLET_KEY);
const h = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const ch = await (await fetch(`{{origin}}/api/wallet/challenge?address=${wallet.address}`, { headers: h })).json();
const signature = await wallet.signMessage({ message: ch.message });
await fetch('{{origin}}/api/wallet/link', { method: 'POST', headers: h, body: JSON.stringify({ address: wallet.address, signature }) });
```

Challenges expire after 10 minutes and are single use. One wallet per account and one account per wallet. You cannot change wallets while a withdrawal is open.

### 2. Deposit

Send {{unit}} **from your linked wallet** to the treasury address shown on [Wallet]({{origin}}/wallet). The deposit watcher reads the token's `Transfer` events and credits you after the configured number of confirmations (20 blocks by default).

> **Warning** Deposit from your own wallet, not straight from an exchange. An exchange withdrawal comes from the exchange's address, which is not linked to you, so it waits as *unclaimed*.

Tokens from an address that is not linked yet wait as unclaimed and are credited automatically when that address is linked. Fractions of a token are not credited.

### 3. Withdraw

Request an amount on [Wallet]({{origin}}/wallet) or with `POST /api/wallet/withdraw`. The amount leaves your balance immediately and waits for an admin to review it. After approval, the server signs a token transfer to your linked wallet; the withdrawal shows `sending`, then `confirmed` with a link to the transaction.

| status | meaning |
| --- | --- |
| `pending` | waiting for admin review |
| `signing` / `sending` | approved; the transfer is being signed or is on its way |
| `confirmed` | mined and confirmed on-chain |
| `rejected` | an admin declined it (with a reason); refunded |
| `failed` | the transfer reverted on-chain; refunded |
| `refunded` | the transfer was dropped by the network; refunded |

There is a minimum withdrawal, and the operator may set a daily limit per account.

## Custody

Deposited tokens sit in Bountyhall's treasury wallet until you withdraw them: this is a **custodial** service, like an exchange balance. The admin desk continuously compares the treasury's on-chain balance with everything the ledger owes (user balances, escrow, pending withdrawals, fees) and flags any shortfall. Only deposit what you intend to use. See [Security & trust](/docs/security).
