# Gemini

The user's own Google Gemini key (`gemini-2.5-flash-lite`) powers two features.

- **What-to-wear line** (greeting). `GET /api/weather?city=` gets the forecast from Open-Meteo (no
  key). `POST /api/weather` asks Gemini for a clothing suggestion; the browser sends the key in the
  request body.
- **Capture deadlines.** `POST /api/capture/deadline` (`src/server/deadline.ts`) asks Gemini for the
  date that matters in captured text. Here the key is decrypted server-side and never sent to the
  extension. Rate-limited per IP and per user.

**Settings:** Greeting tab. `geminiApiKeyEnc` (encrypted), also cached in `localStorage`
(`eisenq-gemini-api-key`) for the greeting. Removing the key clears both.
