# Inventory Helper — backend

Express + TypeScript API for the delivery-receipt inventory app, backed by
Supabase (Postgres) and Google Cloud Vision (receipt OCR). The frontend lives
in the separate `osave-inv-helper-ui` repo. Architecture and conventions are
in `CLAUDE.md`; API shapes in `AI_DOCS/frontend-contract.md`.

## Local development

Requires Node 24.

```bash
npm install
cp .env.example .env     # fill in Supabase + Google credentials
npm run dev              # http://localhost:4000, GET /health → {"status":"ok"}
npm test
npm run store:passcode -- <store_code> [name]   # create a store / set its passcode (+ sign-in QR in store-qr/)
```

## Deployment

Hosted on **Railway** as a single always-on service (the frontend is on
Vercel). Branches: features merge into `develop`; `production` is what
Railway deploys.

It must stay **one instance, not serverless**: the OCR and wrong-passcode
limits are counted in memory, and serverless body limits (~4.5MB) are below
the 10MB photo limit.

Railway builds it with Railpack, which picks up everything from
`package.json`: Node 24 (`engines`), `npm run build` (`tsc`), then
`npm start` (`node dist/index.js`). There's no `railway.json`: Railway has
deprecated config files (no longer accepted for new services), so the
health check and restart policy are set in the service's dashboard settings.

### Environment variables

| Variable | Value |
| --- | --- |
| `SUPABASE_URL` | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Same page, the `service_role` secret (never the anon key, never in the frontend) |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | The Vision service account's JSON key, pasted as-is (no surrounding quotes) |
| `ALLOWED_ORIGINS` | The frontend's URL(s), comma-separated, exact: `https://<app>.vercel.app` (no trailing slash) |
| `TRUST_PROXY` | `1` (Railway's proxy). Leave unset locally |
| `OCR_RATE_LIMIT_PER_MINUTE` | Optional, default `30` |
| `OCR_DAILY_LIMIT` | Optional, default `300` (server-wide Vision calls per 24h) |
| `PASSCODE_ATTEMPTS_PER_15_MIN` | Optional, default `10` |

Don't set `PORT`: Railway provides it and the server reads it.

### Database

Schema changes aren't applied by the deploy. New files in
`supabase/migrations/` are run by hand in the Supabase SQL editor before
deploying code that needs them (`AI_DOCS/backend-left-to-do.md` records
which ones are applied). Stores and their passcodes are created with
`npm run store:passcode`, run locally with `.env` pointing at the same
Supabase project.
