# Vacature Radar

A personal macOS menu-bar app that watches Flemish social-sector job sites (VDAB, VVSG, Jobsolutions, Fiola vzw, Socius, Helan and any listing page you add), extracts the vacancies, and scores each one against your LinkedIn profile with Claude. New strong matches arrive as a notification. Everything runs on your Mac.

## Requirements

- Apple Silicon Mac.
- Node 22 or newer (for example `brew install node`).
- An Anthropic API key from console.anthropic.com.

## Build and install

```
npm ci
npm run dist:mac
```

Then drag `release/mac-arm64/Vacature Radar.app` to `/Applications`. The app carries an ad-hoc signature only, so on first launch macOS may say it cannot be verified: open System Settings > Privacy & Security and choose Open Anyway.

`npm start` packages the app into `release/mac-arm64/Vacature Radar.app` and opens it, so the Dock and menu bar show "Vacature Radar". `npm run dev` runs it without packaging, which is faster to start but shows "Electron" in the Dock and menu bar.

Closing the window keeps the app running in the menu bar (the ◎ icon). Scans run every 6 hours while the Mac is awake, and a missed scan is caught up after the Mac wakes. Quit from the menu bar icon. The interface language can be switched between English and Dutch with the EN | NL toggle in the sidebar and in Settings.

## First-time setup

1. **Settings:** paste your API key and save. It is validated with a tiny request before it is stored.
2. **Profile:** import your LinkedIn data, either way works:
   - Data export zip: LinkedIn > Settings > Data privacy > Get a copy of your data (the zip is processed locally).
   - Profile PDF: your profile > More > Save to PDF (Claude converts it to text, a few cents).

   Then fill in the preferences (home location, commute, hours, contract types, deal-breakers). Use exclude keywords such as `technisch, boekhouder, ICT` to skip irrelevant local-government jobs before any tokens are spent.
3. **Travel time (optional):** create a free account at openrouteservice.org, copy the API key from the dashboard into Settings > Travel time, and put your home location in Profile (a street address is more precise than a town). Each vacancy then shows the driving time from home, without traffic, and Claude uses that number when it judges the commute. The Inbox can sort by distance and filter on a maximum drive time. The detail pane shows which place was matched, so a wrong match is easy to spot.
4. **Sources:** the default sources work without a key. Use Test on any source you add. You can add your own listing URLs, for example a VDAB search with your own filters.

## How it works

For each source the app fetches the listing page and extracts vacancies with the first tier that works:

1. RSS or Atom feed.
2. JSON-LD `JobPosting` data.
3. A saved recipe (CSS selectors for the listing cards).
4. Claude learns a recipe from the page (Sonnet 5.5 by default). The recipe is then reused for free.
5. Claude extracts vacancy links directly from the page.

New vacancies go through your keyword prefilter, then the detail page is fetched and Claude (Opus 5.5 by default) scores the fit from 0 to 100 with reasons and gaps. Duplicates across sources are linked and scored once. Vacancies that disappear from a listing are closed after several scans, and ones past their deadline are closed too. Anything you marked interested, applied or dismissed is never closed automatically.

Limits: a monthly budget (default $5) stops all Claude calls when reached, and at most 25 new vacancies are scored per source per scan (the rest can be scored by hand with Score anyway).

## Costs

Roughly $0.02 per scored vacancy with Opus 5.5 at low effort. Learning a page layout costs a few cents once per site. Choosing Haiku 5.5 for scoring is far cheaper, at some loss of judgment. Settings shows this month's spend by purpose.

## Where data lives

- Database: `~/Library/Application Support/Vacature Radar/radar.db`
- API keys (Anthropic and OpenRouteService): encrypted with Electron safeStorage (macOS Keychain).
- Nothing leaves the Mac except page fetches from the job sites, calls to the Claude API, and place names plus coordinates sent to OpenRouteService for travel times. Geocoding results are cached, so each place is looked up once.

## Troubleshooting

- The status dot on a source shows the last result, hover for the error. The Activity view has the full log.
- "No vacancies found": the page layout is unknown. Add an API key so Claude can learn it, or use Reset recipe on the source and scan again.
- A recipe that stops working is relearned automatically (this needs the key and costs a few cents).
- "Blocked by robots.txt": the site forbids automated access to that URL and the app will not fetch it.
- Test explains empty results: how much text and how many links it saw, which embedded widgets or job portals the page uses, and what to try. When vacancies live on a hosted portal (for example Jobtoolz), Test offers a button to add that portal as a source.
- Some job widgets (for example Jobat on Zorgnet-Icuro) sit behind Cloudflare bot protection. They usually work from a normal home connection; if Test still shows nothing, the hint says so.
- Vacancies stay "pending" without a key, a profile, or budget. They are scored as soon as that is fixed.
- Travel time missing: "unavailable" means no OpenRouteService key or home location; "could not place" means the vacancy names no recognizable town. Settings > Recompute all travel times retries everything. If the free quota is hit, travel times resume on the next scan.

## Politeness

robots.txt is respected, requests to the same site are at least 3 seconds apart, and the hidden browser is only used for sites that need JavaScript (VDAB).

## Development

```
npm test
npm run typecheck
npm run scan-cli -- test <url> [--browser] [--recipe '<json>']
npm run scan-cli -- detail <url> [--browser]
npm run scan-cli -- scan --db ./dev.db [--source <id>]
```

`scan-cli` runs the core pipeline without Electron. `--browser` needs Playwright installed globally. The LLM tiers are on only when `ANTHROPIC_API_KEY` is set. See `DESIGN.md` for the architecture.
