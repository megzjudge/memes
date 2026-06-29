# Memes at MBTI.ninja

A browseable collection of MBTI-themed memes hosted at [memes.mbti.ninja](https://memes.mbti.ninja/), built as a static site with a Cloudflare Worker backend.

## What it does

- Serves 350+ MBTI personality-type memes sourced from [@mbtininja on Imgflip](https://imgflip.com/all/user-images/mbtininja?sort=latest)
- Lets visitors filter memes by MBTI type, meme type, and keywords
- Tracks view counts via a Cloudflare Worker
- Runs a nightly cron job (via Cloudflare Workers scheduled triggers) to automatically sync new memes from Imgflip into `memes.csv`

## Stack

| Layer | Tech |
|---|---|
| Hosting | Cloudflare Workers + Assets |
| Scraper / view counter | Cloudflare Worker (`worker.js`) |
| Browser automation | `@cloudflare/puppeteer` |
| Frontend | Vanilla HTML / CSS / JS |
| Meme data | `memes.csv` (flat-file, no database) |

## Project structure

```
memes/
├── index.html        # Main page
├── script.js         # Frontend filtering & rendering
├── styles.css        # Styles
├── worker.js         # Cloudflare Worker (scraper + view counter)
├── memes.csv         # Meme metadata (ID, URL, MBTI types, tags…)
├── meme-views.csv    # Per-meme view counts
├── wrangler.toml     # Cloudflare Workers config
├── fonts/            # Web fonts
└── images/           # Icons and SVGs
```

## Running locally

```bash
npm install
npx wrangler dev
```

Requires a [Cloudflare account](https://dash.cloudflare.com/) and `wrangler` CLI for the Worker features. The static site itself runs without any dependencies.

## Deploying

```bash
npx wrangler deploy
```

## License

See [LICENSE](LICENSE).
