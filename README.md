# Blitz Lead Engine

Internal tool that chains BlitzAPI endpoints into pipelines, for example:
filters → Find People → email → phone → save (Supabase Postgres + CSV/Excel).

Every step runs at the same time. A row moves to the next step as soon as it's ready, while the search keeps fetching new pages.

- **Builder** (`/`): pick steps from all Blitz endpoints, plus ICP Fit, Only new, Buying Committee, Job-change check, and Google Sheet/Webhook. Run it and watch it live.
- **Jobs** (`/jobs`): a queue of pipelines that run unattended until each filter has no more results. When one finishes, the next one starts.

Built with **Next.js** (App Router). It runs as one always-on Node server (`next start`), because the pipeline, the live view and the job scheduler live inside that process. So it can't be hosted on Vercel or other serverless platforms.

## Features at a glance
- **Import a file** (CSV, TSV, TXT, Excel .xlsx, or a saved pipeline/job .json): the column with domains, LinkedIn URLs, emails or phones is detected and filled into step 1, the right steps are added, your file's other columns come back in the results (`in_…`), and **Create job** runs it in the background. A file with both LinkedIn company URLs and domains uses the LinkedIn URL when present (free) and the domain otherwise; a file with both people and companies offers a second job.
- **Cost preview:** 💰 Estimate cost (a search asks Blitz how many matches there are, 1 record; a list is counted for free) and 🧪 Test 10 rows.
- **Failed steps:** a step that fails for a lead (after its retries) is recorded and shown in the `failed_step` column; **Re-run failed** puts just those leads back at that step and replaces their incomplete rows.
- **Job auto-retry:** a job that hits an error continues from where it stopped after 5 min, then 30 min, then 2 h, then alerts you. Bad settings (HTTP 4xx) are not retried.
- **Leads page:** every saved lead, searchable and filterable (has email/phone, country, job), with downloads of exactly what's filtered.
- **Spend page:** records per step, per job and per day, with hit rates and error rates.
- **Provider cache:** answers to single-input lookups (email, phone, company, person, domain ↔ LinkedIn, reverse lookups) are kept in Postgres (90 days for emails and phones, 180 for domain ↔ LinkedIn, 30 for company/person; not-found answers 14–30 days) and reused for free. Untick "Reuse recent lookup answers" (or set `use_cache: false` on a job) for fresh data; the job-change check always asks Blitz. `CACHE=off` turns it off everywhere. Live cards and the Spend page show "from cache (free)".
- **Big tables:** Leads search uses a trigram index on name/company/email/domain/title, filters have their own indexes, and match counts stop at "10,000+" instead of counting millions of rows.
- **Exports stream** from the database in chunks, so very large downloads don't run out of memory.

## Run it locally
```
npm install
cp .env.example .env    # put BLITZ_API_KEY and DATABASE_URL in it
npm run dev             # development → http://localhost:4000
npm run build && npm start   # production → http://localhost:4000
```

## Database (Supabase)
All data lives in Supabase Postgres: leads (`rows`), the duplicate memory (`seen`), the "only new" memory (`watch`), and job state (`jobs`, `job_runs`, `usage`, `settings`).
- **Connection:** `DATABASE_URL` is the Supabase **Session pooler** connection string (Connect → Session pooler), with your database password. The server connects directly over Postgres, which is much faster than the REST API for batch writes.
- **Tables** are created automatically on first start.
- **Private by default:** Row Level Security is on for every table with no policies, so Supabase's public (publishable) key can't read or write them. Only the server, through `DATABASE_URL`, can.
- **Speed:** duplicate checks and row saves are batched (one query per batch, not per row), and a row counts as saved only once it's in the database. Job resume points move forward only after that.
- **Moving old local data:** `npm run db:migrate-sqlite` copies `data/leads.db` (SQLite) into Supabase once. It's safe to run twice.

## How work runs (Postgres queue)
Work is kept in Postgres, not in server memory, so any number of workers can share it and a crash loses nothing.

- **items**: one row per lead in progress, holding the step it waits for. Workers claim batches with `FOR UPDATE SKIP LOCKED`, so no row is ever done twice. They call Blitz, then commit the whole batch in one transaction: the result, the hand-off to the next step, new rows (1 company → many people), and the saved lead.
- **Leases**: a claimed batch has a 2-minute lease that the worker renews while it works. If the worker dies, the reaper puts its rows back in the queue.
- **Search paging** runs as a **pg-boss** job (schema `pgboss`). Each page is committed together with its cursor, so a crash re-buys at most one page. Paging pauses while 1,000 rows wait, so spending follows progress.
- **Retries**: rate limits, timeouts and 5xx errors are retried 3 times with growing waits. Other errors keep the row and are shown once in the log.
- **Duplicates** are checked across all workers (`run_seen`) and against earlier runs (`seen`).
- **Stop** leaves unfinished rows in the queue, so a job resumes exactly where it stopped.
- **Live view** reads the run from Postgres every second, so it works whichever process does the work.

**Scaling out:** the web server runs one worker by default. For more throughput, start extra workers with `npm run worker` (on any machine with the same `.env`), and set `RUN_WORKER=false` on the web server if you like. Blitz limits are per API key, so with N worker processes set `BLITZ_RPS` to about your limit ÷ N.

## Jobs (the queue)
- **One file per pipeline** goes in `jobs/`, for example `01-saas-us.json` or `02-fintech-uk.json`. Drop a file in and it's queued within seconds. **Save as job** in the builder writes the file for you. Examples are in `job-examples/`.
- **Progress** is saved in Postgres after every page and every batch. A job keeps going until its search is fully read, then it is **done** and the next job starts.
- **Crashes and redeploys** lose nothing: rows a worker held go back to the queue when its lease runs out, and paging continues from the saved cursor.
- **Budgets.** `record_budget` is per job (per cycle). When it's used up, the job pauses and the queue moves on. Raise the budget in the file, then press Resume. A **daily record budget** across all jobs, and **how many jobs run at once**, are set on the Jobs page. Manual runs from the builder don't count toward the daily budget.
- **Failures.** A bad filter or running out of records marks the job **failed**, sends an alert, and the queue moves on.
- **Repeats.** `"repeat_every_hours": 24` runs the job again after it finishes. Pair it with the **Only new since last run** step, plus filters such as "posted in the last day", so each cycle buys little.
- **Big filters.** One Blitz search stops at 50,000 results. Use `"split": { "field": "company.hq.country_code", "values": ["US","GB","DE"] }` to make one job per value.
- **Edits.** Changing budget, workers or repeat keeps progress. Changing steps or filters starts that job over.
- **Pasted-list sources** (domains, URLs, emails) are read in one go; after that, their rows go through the queue like any other.

## Deploy (Vercel + Trigger.dev + Supabase)
| Part | Where | How |
|---|---|---|
| Website (Next.js) | **Vercel** (Pro: commercial use, long downloads) | Import the GitHub repo |
| Workers (`drain-queue`, `scheduler-tick`, `export-leads`) | **Trigger.dev** | `npm run trigger:deploy` |
| Data, queue, uploads, exports | **Supabase** (Pro recommended: no pausing, backups) | Already set up; tables are created automatically |

1. **Trigger.dev → Production → Environment variables:** `BLITZ_API_KEY`, `BLITZ_RPS=50`, `DATABASE_URL` (Supabase **session pooler**, port 5432), `SUPABASE_SECRET_KEY`. Then `npm run trigger:deploy`.
2. **Vercel → Environment variables:** `DATABASE_URL` (Supabase **transaction pooler**, port 6543), `BLITZ_API_KEY`, `EXECUTION=trigger`, `TRIGGER_SECRET_KEY` (the `tr_prod_…` key), `APP_PASSWORD`, `SUPABASE_SECRET_KEY`, `JOB_FILES=off`, optional `ALERT_WEBHOOK_URL`.
3. Deploy, open the URL (the browser asks for the app password), and run a free test (Saved people → ICP Fit) before real jobs.

What makes it work on serverless hosting:
- **Live view** reconnects every ~40 s from where it left off (no repeats).
- **Imports** are read in the browser and sent in small chunks to `uploads` (never over the 4.5 MB request limit).
- **Alerts** are stored in the database, so every machine sees them.
- **Big downloads** (Leads page) are built by the `export-leads` task and stored in a private Supabase Storage bucket; you get a 1-hour download link.
- **Database connections** stay small per instance (3 on Vercel).

The `Dockerfile` still works for an always-on server instead (without `EXECUTION=trigger`, the server runs its own worker).

## Where things are
- `lib/engine/`: the queue engine (`runs.ts` run state, hand-off and live view; `worker.ts` claiming, batches, paging, reaper; `boss.ts` pg-boss)
- `scripts/worker.ts`: standalone worker (`npm run worker`)
- `lib/steps.ts`: every step (Blitz endpoints + custom tools)
- `lib/jobs.ts`: job files, jobs table, scheduler
- `lib/pg.ts`: Supabase Postgres connection + table definitions
- `lib/db.ts`: leads, duplicate memory, "only new" memory (batched reads/writes)
- `scripts/migrate-sqlite.mjs`: one-time copy of the old SQLite data into Supabase
- `lib/runtime.ts`: the shared Blitz client, live runs and scheduler (one per server)
- `instrumentation-node.ts`: starts the scheduler when the server starts
- `proxy.ts`: app password (`APP_PASSWORD`)
- `app/api/*`: API routes (runs, live progress stream, jobs, downloads)
- `app/page.tsx`, `app/jobs/page.tsx`, `components/`: the React UI

## Notes
- Cost: 1 record per result returned by a search, plus 1 per email or phone found. Lookups that find nothing are free.
- Phone lookup only covers US people.
- Keep `.env` out of git (already in `.gitignore`).
