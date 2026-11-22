# Calendar feeds (iCal)

Today's events from up to 10 `.ics` feeds, shown beside the routine. Read-only.

- **Settings:** Integrations → Calendar feeds. `icalUrlsEnc`: an encrypted JSON array. A secret iCal URL is a
  credential, hence the encryption. Also cached in `localStorage` (`eisenq-ical-urls`).
- **Routes:** `POST /api/calendar/feeds` fetches all feeds and returns today's events grouped by
  calendar (start and end of day computed in the browser's time zone); `GET /api/calendar?url=`
  fetches one. Both use `safeFetch`, send `User-Agent: EisenQ Calendar/1.0`, take the calendar
  name from `X-WR-CALNAME`, and rate-limit per IP (in memory, per instance).
- **Google Calendar:** users must use the *Secret address in iCal format*; the public URL only
  works for public calendars.
