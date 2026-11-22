# CashFold

Shows the day's payments, grouped by account, and where the day ends, above the Priority Matrix.

- **Settings:** Integrations → CashFold. `financeApiUrlEnc`, `financeApiKeyEnc`, `financeUserIdEnc` (encrypted).
- **Module:** `src/server/finance.ts`, used by both routes so "Test connection" exercises the real request.
- **Routes:** `GET /api/payments?date=YYYY-MM-DD` (proxy); `POST /api/payments/test` (tests the
  values typed in the form before saving; omitted fields fall back to stored ones).
- **Request:** the endpoint with `{date}` substituted (or `?date=` appended), `?userId=` from the
  user ID field, `X-API-Key` header. Fetched with `safeFetch`.
- **Errors:** `/api/payments` stays terse; diagnosis is the test route's job, in plain language.
