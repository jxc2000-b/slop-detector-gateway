# pangramapi-gateway

Cloudflare Worker that sits between the app and upstream APIs (Pangram for now).
The app never sees the upstream key; each device gets a metered slice of usage.

## API

| Route | Auth | Notes |
|---|---|---|
| `POST /v1/register` | none | Returns `{ deviceId, token, tier }`. 10/day per IP. |
| `GET /v1/me` | device | Tier, revoked flag, today's usage. |
| `GET /v1/pangram/models` | device | Free, rate limited. |
| `POST /v1/pangram/task` | device | Costs 1 from the daily quota. |
| `GET /v1/pangram/task/:id` | device | Free; only tasks this device created. |
| `GET /admin/devices/:id` | admin | Inspect a device. |
| `PATCH /admin/devices/:id` | admin | Body `{ "tier": "free" \| "paid", "revoked": bool }`. |

Device auth: `Authorization: Bearer <token>`. Billable responses include
`X-Quota-Limit`, `X-Quota-Remaining`, `X-Quota-Reset`. Over quota → `429` with `Retry-After`.
Failed upstream calls are refunded.

Tiers and limits live in `src/tiers.ts` (free: 3 Pangram classifications/day, paid: 100).
`GLOBAL_DAILY_CAP` in `wrangler.jsonc` caps total billable calls across all devices.

## Adding a provider

Add a file in `src/providers/` describing its base URL, auth header, secret binding and
allow-listed routes, register it in `src/providers/index.ts`, add its daily limit per tier,
and add the secret binding to `wrangler.jsonc` and `src/env.d.ts`.

## Setup

```sh
npm install
npx wrangler secrets-store store list --remote   # copy the id of "store" into wrangler.jsonc
npx wrangler secret put TOKEN_SECRET              # long random string
npx wrangler secret put ADMIN_SECRET
npm test
npm run deploy
```

Local dev: copy `.dev.vars.example` to `.dev.vars`.
