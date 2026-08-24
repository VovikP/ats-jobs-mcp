# Greenhouse, Lever, Ashby, Workable, Teamtailor Jobs API

One API for six applicant tracking systems: **Greenhouse, Lever, Ashby, Workable, Teamtailor and SmartRecruiters**.

Give it a company website. It finds the job board itself, returns every open role, and on every run after that returns **only what changed** — roles opened, roles closed, titles moved, salaries changed — plus derived hiring signals.

```json
{ "domains": ["stripe.com", "spotify.com", "pleo.io"] }
```

No board tokens. No ATS knowledge required. No browser.

---

## Two ways to run it

| | Hosted on Apify | Self-hosted MCP server |
|---|---|---|
| Setup | none | `npx ats-jobs-mcp` |
| State between runs | managed | local file |
| Scheduling, retries, storage | included | your own |
| Price | $1 per 1,000 jobs | free |
| Link | [apify.com/feedworks/ats-jobs-api](https://apify.com/feedworks/ats-jobs-api) | this repo, `mcp/` |

The logic is the same code in both. Pick whichever fits.

---

## What you get

| Event | Meaning |
|---|---|
| `job_indexed` | Baseline: an open role captured on the first run |
| `job_posted` | A new opening appeared |
| `job_closed` | An opening disappeared |
| `job_changed` | Title, location, department or employment type changed |
| `salary_changed` | Compensation changed |
| `hiring_accelerating` | This month's postings are 2× or more the recent average |
| `first_role_in_function` | First ever hire in sales, AI/ML, security, data — a new budget line opened |
| `hiring_freeze` | Postings dropped to zero after steady hiring |

Every record carries provenance: source URL, HTTP status, fetch time, job count, truncation flag and a `confidence` value — so an agent can verify before it acts, instead of trusting a claim.

---

## MCP server

```bash
npx ats-jobs-mcp
```

Four tools, usable by any MCP client — Claude Desktop, Cursor, VS Code, your own agent:

| Tool | Question it answers |
|---|---|
| `find_job_board` | Which ATS does this company use, and what is its board token? |
| `list_jobs` | What roles are open right now? |
| `detect_changes` | What changed since the last time I looked? |
| `hiring_summary` | What is this company hiring for — which functions, which locations? |

Claude Desktop config:

```json
{
  "mcpServers": {
    "ats-jobs": { "command": "npx", "args": ["-y", "ats-jobs-mcp"] }
  }
}
```

State lives in `~/.ats-jobs-mcp/state.json`. Override with `ATS_MCP_STATE`.

---

## Why it stays cheap to run continuously

Every source is polled with `If-None-Match`. When nothing changed, the ATS answers `304` with no body.

Measured on the hosted Actor at 512 MB:

| Path | Compute |
|---|---|
| Nothing changed (`304`) | 0.000344 CU per run |
| Baseline, 143 jobs | 0.001386 CU |

That is why watching hundreds of companies every few hours costs cents rather than dollars — and why this project will never open a headless browser to read a job board.

---

## What it deliberately does not do

- **No personal data.** Recruiter names, emails and phone numbers are stripped at parse time and never stored.
- **No headless browser, no proxies.** Only public ATS endpoints that answer with JSON.
- **No false layoffs.** If a source response may be truncated by paging, `job_closed` events are suppressed — a paging artefact must never look like a company shutting down hiring.

---

## Supported sources

`greenhouse` · `lever` · `ashby` · `workable` · `teamtailor` · `smartrecruiters`

Detection order: a link on the company careers page → the board token guessed from the domain → Workable short links resolved through their redirect.

Companies that cannot be resolved return a `source_unresolved` record explaining why, instead of failing silently.

Recruitee and Personio are not listed because they are not verified working. Personio currently answers `429` to non-browser clients; Recruitee endpoints did not resolve in testing. This project does not claim coverage it cannot deliver.

---

## Repo layout

```
src/          Apify Actor: adapters, diff engine, derived signals
mcp/          MCP server — the same engine, self-hosted
tools/        discovery utilities (domain → ATS)
.actor/       Apify manifests and schemas
```

MIT licensed. Contributions welcome, especially new ATS adapters — the interface is one `url()` and one `parse()` function per system, see `src/adapters/index.js`.
