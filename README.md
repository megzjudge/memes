# Memes at MBTI.ninja

A self-updating MBTI meme gallery at [memes.mbti.ninja](https://memes.mbti.ninja/). Every night a Cloudflare Worker scrapes the [@mbtininja Imgflip account](https://imgflip.com/all/user-images/mbtininja?sort=latest), enriches new memes with metadata, updates view counts for the whole collection, and commits everything back to this repo as CSV — no database required.

## How it works

The Worker runs on a nightly cron (`0 21 * * *`) and does three things in sequence:

**Step 1 — Discover.** Scrapes the @mbtininja Imgflip profile page for new image IDs. Any ID not already in `memes.csv` gets appended as a new row.

**Step 2 — Enrich.** For each new meme (and a rolling top-2 for corrections), it fetches the Imgflip page and extracts: title, image URL, meme type, MBTI tags, keywords, and the Know Your Meme slug. Writes everything back to `memes.csv` via the GitHub Contents API.

**Step 3 — View counts.** Fetches the current view count for every meme in the collection from Imgflip's `__NEXT_DATA__` JSON, then writes a separate `meme-views.csv`. The frontend merges both CSVs at load time.

The Worker also emails via SendGrid if the Imgflip session cookie expires, and exposes a `/run` endpoint to trigger the pipeline manually.

## Frontend

The site is plain HTML + vanilla JS — no framework, no build step. On load it fetches both CSVs in parallel, merges them, and renders the meme grid. Filters for MBTI type, meme type, and keyword are built dynamically from the data; button size and colour are log-scaled by frequency so the most-used tags stand out visually. Sort by newest/oldest or by views.

## Data files

| File | What it contains |
|---|---|
| `memes.csv` | Master meme list — ID, URLs, title, meme type, KYM slug, MBTI types, keywords, tags |
| `meme-views.csv` | View counts only — updated nightly, kept separate so enrichment and view-count writes don't clobber each other |

## Stack

- **Hosting:** Cloudflare Workers + Assets (serves the static site)
- **Automation:** Cloudflare Workers scheduled triggers + `@cloudflare/puppeteer`
- **Data store:** Flat CSV files committed to GitHub via the REST API
- **Email alerts:** SendGrid (cookie expiry notifications)
- **Frontend:** Vanilla HTML / CSS / JS

The Worker expects these secrets set in Cloudflare:

| Secret | Purpose |
|---|---|
| `IMGFLIP_COOKIE` | Authenticated Imgflip session cookie |
| `GITHUB_OWNER` | GitHub username or org |
| `GITHUB_REPO` | Repo name |
| `GITHUB_TOKEN` | Personal access token with `contents: write` |
| `ROUTING_EMAIL` | Address for SendGrid alert emails |
| `ROUTING_EMAIL_API` | SendGrid API key |
