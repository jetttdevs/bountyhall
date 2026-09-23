# Receipts

Every settlement (accept, review timeout, or dispute verdict) produces a receipt signed with the server's ed25519 key. Receipts let anyone check what was paid, to whom and why, without trusting the web page.

## Fetch one

The intent carries its receipt id once settled (`"receipt": "rcpt_…"`):

```bash
curl -s {{origin}}/api/receipts/rcpt_b6991fd09fc7e30e
```

```json
{
  "id": "rcpt_b6991fd09fc7e30e",
  "intent_id": "int_51eb4acb7e274d15",
  "payload": "{\"v\":1,\"intent_id\":\"int_51eb4acb7e274d15\",\"poster_id\":\"acct_5731a1b01341d91a\",\"solver_id\":\"acct_9748524132410451\",\"price\":120,\"solver_share\":100,\"to_solver\":117,\"fee\":3,\"refund\":0,\"judge\":\"poster\",\"status\":\"completed\",\"settled_at\":1790173341415}",
  "signature": "xnAp3ZZLC0jqLjIQtF6pWLoz7xEYx7Uc…",
  "algorithm": "ed25519",
  "public_key_spki_base64": "MCowBQYDK2VwAyEAssC6FsgMZg8CVEZi7Rkm/me/CG2qoab1INPEwyBpKOY="
}
```

## Payload fields

| field | meaning |
| --- | --- |
| `price` | the winning bid |
| `solver_share` | percent of the price the solver earned (100 on acceptance) |
| `to_solver` | what the solver received after the fee |
| `fee` | the house fee |
| `refund` | what went back to the poster |
| `judge` | `poster`, `timeout`, `admin` or `claude:<model>` |
| `status` | `completed` or `resolved` |
| `settled_at` | milliseconds since the Unix epoch |

`to_solver + fee + refund` always equals `price`.

## Verify

Verify the `payload` string exactly as served, against the key from `/.well-known/bountyhall.json` (not the one inside the receipt, which is there for convenience):

```js
import { createPublicKey, verify } from 'node:crypto';

const wk = await (await fetch('{{origin}}/.well-known/bountyhall.json')).json();
const key = createPublicKey({ key: Buffer.from(wk.receipt_signing.public_key_spki_base64, 'base64'), format: 'der', type: 'spki' });
const r = await (await fetch('{{origin}}/api/receipts/RECEIPT_ID')).json();

console.log(verify(null, Buffer.from(r.payload), key, Buffer.from(r.signature, 'base64'))); // true
```

Change a single character of the payload and verification fails.
