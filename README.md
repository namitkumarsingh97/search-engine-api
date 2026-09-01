# MiniSearch — Backend API

A small search engine built from scratch: crawler → tokenizer → inverted index → ranking → Express API. This is the backend for [MiniSearch](../search-engine-frontend); it owns crawling, indexing, search, and MongoDB storage.

## Stack

- **Node.js** + **Express** + **TypeScript**
- **MongoDB** (via Mongoose) — page storage, crawl queue, search history
- **Cheerio** — HTML parsing
- In-memory inverted index (rebuilt from MongoDB on boot)

## How search works here

```
HTML → Crawler → Text extraction → Tokenizer → Inverted Index → Query processing → Ranking → Results
```

- **Tokenizer** (`src/search/tokenizer.ts`) — lowercases, strips punctuation, drops stopwords
- **Inverted index** (`src/search/indexer.ts`) — `Map<term, Set<docId>>`, kept in memory for speed; rebuilt from MongoDB on server boot so nothing needs to be re-crawled after a restart
- **Ranking** (`src/search/ranking.ts`) — weighted scoring (title × 5, headings × 3, URL × 2, body × 1), plus a TF-IDF scorer for later use
- **Crawler** (`src/crawler/`) — respects `robots.txt`, rate-limits requests, caps total pages and depth, dedups visited URLs

## Getting started

```bash
npm install
cp .env.example .env
```

Fill in `.env` with your MongoDB connection string (see below), then:

```bash
npm run seed   # optional — loads data/documents.json into MongoDB
npm run dev    # starts the API with hot reload
```

The API listens on `http://localhost:4000` by default. Check `http://localhost:4000/api/health` to confirm it's up.

### Search without MongoDB

You don't need MongoDB running to try the core search logic:

```bash
npm run search "python web"
```

This runs the tokenizer/index/ranking pipeline directly against `data/documents.json` — no database, no server.

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `PORT` | API port | `4000` |
| `MONGODB_URI` | MongoDB connection string (Atlas or local) | `mongodb://127.0.0.1:27017/mini-search` |
| `CRAWL_DELAY_MS` | Delay between crawler requests | `1000` |
| `MAX_PAGES` | Max pages per crawl run | `100` |
| `MAX_DEPTH` | Max link-following depth | `2` |
| `CORS_ORIGIN` | Allowed frontend origin | `http://localhost:3000` |

If using MongoDB Atlas: whitelist your IP under **Network Access**, and include a database name in the URI path (e.g. `/mini-search`) or it'll default to `test`.

## API routes

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/search?q=...` | Run a search query |
| `GET` | `/api/search/autocomplete?q=...` | Prefix autocomplete over indexed terms |
| `POST` | `/api/crawler/start` | Start a crawl — body: `{ seedUrls: string[] }` (must be full `http(s)` URLs) |
| `POST` | `/api/crawler/stop` | Stop the current crawl |
| `GET` | `/api/crawler/status` | Current crawler status |
| `GET` | `/api/crawler/recent` | Recently crawled URLs and their status |
| `GET` | `/api/stats` | Indexed pages, domains, terms, queue size |
| `GET` | `/api/stats/top-queries` | Most frequent search queries |

## Project structure

```
data/
└── documents.json        # Sample docs for npm run search / npm run seed

src/
├── server.ts              # Express app entry point
├── types.ts                # Shared types

├── search/
│   ├── tokenizer.ts
│   ├── indexer.ts          # In-memory inverted index
│   ├── ranking.ts          # Weighted + TF-IDF scoring, snippets
│   └── search.ts           # Query processing / autocomplete

├── crawler/
│   ├── robots.ts
│   ├── parser.ts            # Cheerio HTML extraction
│   ├── urlQueue.ts          # Dedup + Mongo-backed queue
│   └── crawler.ts           # Main crawl loop

├── database/
│   ├── connection.ts
│   └── models/
│       ├── Page.ts
│       ├── CrawlQueue.ts
│       └── SearchHistory.ts

├── routes/
│   ├── search.routes.ts
│   ├── crawler.routes.ts
│   └── admin.routes.ts

└── scripts/
    ├── search-cli.ts        # npm run search "query"
    └── seed.ts               # npm run seed
```

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start the API with hot reload (`tsx watch`) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start` | Run the compiled build |
| `npm run search "<query>"` | CLI search against `data/documents.json`, no DB needed |
| `npm run seed` | Load `data/documents.json` into MongoDB |

## Crawler rules

The crawler is intentionally conservative by default:

- Checks `robots.txt` before fetching any page
- Waits `CRAWL_DELAY_MS` between requests (default 1s)
- Stops at `MAX_PAGES` pages or `MAX_DEPTH` link depth
- Skips duplicate/already-visited URLs
- Seed URLs must be full `http(s)` URLs — invalid input is rejected with a `400`, not crashed on

## Notes

- The in-memory index is rebuilt from MongoDB every time the server boots (`loadIndexFromDatabase` in `server.ts`) — crawled or seeded pages are searchable immediately, no re-crawl needed after a restart.
- Never commit `.env` — it's gitignored, and if a real connection string ever ends up in a chat log, commit history, or anywhere public, rotate the password in Atlas.
