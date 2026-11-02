# Blitz Lead Engine

Internal tool: filters → **Find People** → **duplicate check** → **email + phone** → **save (SQLite + CSV/Excel)**.
All four stages run at the same time: each person goes to the next stage as soon as it's found, while search keeps fetching new pages.

## Run it
```
npm install
cp .env.example .env    # put your BLITZ_API_KEY in it
npm start               # → http://localhost:4000
```

## Where things are
- `src/pipeline.ts`: the 4-stage parallel pipeline (start here)
- `src/db.ts`: SQLite lead database (`data/leads.db`), also the duplicate checker
- `src/export.ts`: live CSV writer + Excel export
- `src/server.ts`: API + live progress stream (SSE)
- `public/`: the web page
- `data/exports/`: one CSV per run, written row by row during the run

## Notes
- Cost: 1 record per person found, +1 per email found, +1 per phone found. Lookups that find nothing are free.
- Phone lookup only covers US people. Everyone else gets email only.
- Keep `.env` out of git (already in `.gitignore`).
