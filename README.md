# QueueStorm Warmup Ticket Sorter

Small Bun + Hono service for the SUST CSE Carnival 2026 Codex Community Hackathon mock preliminary round.

It classifies one CRM ticket into:

- `case_type`: `wrong_transfer`, `payment_failed`, `refund_request`, `phishing_or_social_engineering`, or `other`
- `severity`: `low`, `medium`, `high`, or `critical`
- `department`: `customer_support`, `dispute_resolution`, `payments_ops`, or `fraud_risk`
- a short, safe `agent_summary`
- `human_review_required` for phishing or critical cases

The implementation is rules-based and does not use an LLM, GPU, or repository secrets.

## Completeness

- `GET /health` returns a simple JSON health response.
- `POST /sort-ticket` accepts one CRM ticket and returns the required JSON classification.
- `ticket_id` is echoed exactly from the request.
- `channel` is optional and validated when present: `app`, `sms`, `call_center`, `merchant_portal`.
- `locale` is optional and validated when present: `bn`, `en`, `mixed`.
- `case_type`, `severity`, and `department` are always returned from the required enum sets.
- `human_review_required` is `true` for phishing/social-engineering cases and any critical severity case.
- `agent_summary` uses fixed neutral templates and never asks for PIN, OTP, password, or full card number.

## Operational Guards

- All routes have a coarse global limit of 600 requests per minute per client.
- `GET /health` has an additional limit of 300 requests per minute per client.
- `POST /sort-ticket` has an additional limit of 120 requests per minute per client.
- Request bodies are limited to 8 KB.
- Requests time out after 25 seconds, below the 30 second task limit.
- Unknown routes and invalid requests return JSON error responses.
- Security headers are enabled through Hono middleware.

The in-memory rate limiter is a lightweight backstop for a busy API. On multi-instance or serverless deployments, use the hosting platform, CDN, or API gateway for global rate limiting.

## Performance

- The classifier is deterministic and runs locally in-process; it does not call an LLM or external API.
- Keyword scoring is a single pass over small fixed rule sets.
- Amount extraction tracks only the largest detected amount and does not allocate a list per request.
- The test suite includes a throughput sanity check that classifies 500 tickets in under 1 second on the local machine.
- Runtime limits are set below the task requirements: `/health` is tested under the 10 second budget and all requests time out after 25 seconds, below the 30 second `/sort-ticket` limit.

### Local Heavy Benchmark

These numbers are from a local machine and benchmark `/sort-ticket` only. They are useful for comparing implementations in this repository, not for estimating Vercel free-tier capacity.

Command:

```bash
REQUESTS=50000 CONCURRENCY=250 WARMUP_REQUESTS=1000 npm run benchmark
```

| Implementation | Requests | Concurrency | OK | Errors | RPS | vs Bun | vs Previous | Avg | P50 | P95 | P99 | Peak RSS | End RSS |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Bun + Hono | 50,000 | 250 | 50,000 | 0 | 20,200.9 | +0.0% | baseline | 12.35 ms | 11.16 ms | 17.11 ms | 25.96 ms | 72.5 MB | 72.5 MB |
| Rust + Axum | 50,000 | 250 | 50,000 | 0 | 23,092.9 | +14.3% | +14.3% | 10.81 ms | 9.86 ms | 14.77 ms | 19.15 ms | 23.1 MB | 23.1 MB |
| Go stdlib | 50,000 | 250 | 50,000 | 0 | 23,967.0 | +18.6% | +3.8% | 10.42 ms | 9.44 ms | 14.29 ms | 16.90 ms | 71.5 MB | 71.5 MB |
| Python stdlib | 50,000 | 250 | 49,799 | 201 | 6,275.0 | -68.9% | -73.8% | 38.11 ms | 0.65 ms | 4.29 ms | 121.10 ms | 26.0 MB | 25.9 MB |

The Python standard-library comparison server showed errors at this stress level. The deployed implementation is Bun + Hono.

### Combined Workload Averages

These numbers average all four local benchmark workloads together: `health-routing`, `ticket-classify`, `json-shape`, and `cpu-checksum`. Actix Web is also included in the benchmark suite; if dependency fetching is slow, the repository includes Cargo sparse-registry config under `.cargo/config.toml`.

Command:

```bash
REQUESTS=500 CONCURRENCY=25 WARMUP_REQUESTS=50 npm run benchmark
```

| Implementation | Workloads | Total Requests | Total OK | Errors | Avg RPS | vs Bun | vs Previous | Avg Latency | Avg P95 | Avg P99 | Max Peak RSS |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Bun + Hono | 4 | 2,000 | 2,000 | 0 | 11,698.2 | +0.0% | baseline | 6.03 ms | 11.56 ms | 12.24 ms | 63.7 MB |
| Bun + Elysia | 4 | 2,000 | 2,000 | 0 | 17,229.2 | +47.3% | +47.3% | 5.62 ms | 11.86 ms | 12.71 ms | 88.0 MB |
| Rust + Axum | 4 | 2,000 | 2,000 | 0 | 19,018.2 | +62.6% | +10.4% | 1.38 ms | 3.38 ms | 3.65 ms | 6.8 MB |
| Rust + Actix Web | 4 | 2,000 | 2,000 | 0 | 21,835.0 | +86.7% | +14.8% | 1.19 ms | 3.41 ms | 3.69 ms | 8.7 MB |
| Go stdlib | 4 | 2,000 | 2,000 | 0 | 22,294.6 | +90.6% | +2.1% | 1.46 ms | 2.96 ms | 4.34 ms | 58.4 MB |
| Node.js + Express | 4 | 2,000 | 2,000 | 0 | 17,140.8 | +46.5% | -23.1% | 5.35 ms | 10.46 ms | 12.20 ms | 152.3 MB |
| Python stdlib | 4 | 2,000 | 1,974 | 26 | 2,262.0 | -80.7% | -86.8% | 229.23 ms | 1,962.31 ms | 2,321.22 ms | 24.2 MB |

### Result Summary

- **Best overall local throughput:** Go stdlib and Rust Actix Web are the fastest in the combined workload average. Go leads slightly on average RPS, while both Rust servers use far less memory.
- **Best memory footprint:** Rust Axum is the clear winner in this local run, peaking at 6.8 MB across the combined workloads, with Actix Web close behind at 8.7 MB.
- **Best CPU-bound behavior:** Rust and Go pull far ahead on `cpu-checksum`, which is expected because the workload is dominated by tight string/number loops rather than framework routing.
- **Best JavaScript comparison:** Bun + Elysia and Node.js + Express are nearly tied on average RPS in this synthetic local run, but Elysia uses much less memory. Bun + Hono remains the deployed app because it is already complete, simple, fast enough, and fits the Vercel workflow.
- **Python stdlib limitation:** The Python comparison is intentionally dependency-free and uses `ThreadingHTTPServer`, which is not a production high-concurrency server. Its tail latency and errors under stress show why a real Python deployment would use something like Uvicorn, Granian, or another production ASGI/WSGI server.
- **What this means for the hackathon:** Bun + Hono is more than fast enough for the required API. The comparison implementations are useful learning artifacts, but they are not needed for the deployed submission.

Benchmark caveats:

- Results are local synthetic numbers, not public Vercel capacity.
- The benchmark client is Node `fetch`, so client-side limits can influence very high-load runs.
- Memory is sampled from local process RSS and should be treated as approximate.
- Cross-runtime comparisons are directional; framework defaults, compiler warmup, GC behavior, and OS scheduling can change the exact numbers.

## Security

- No secrets are stored in the repository.
- No environment variables are required for classification.
- No GPU or model runtime is used.
- Request bodies are limited to 8 KB to reduce accidental or abusive large payloads.
- Hono security headers are enabled, including `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and HSTS.
- Invalid JSON, invalid schema values, oversized bodies, unknown routes, and rate-limited requests return JSON error responses.
- `bun audit --json` currently returns no known dependency advisories.
- Static review found no dynamic code execution, shell execution, secret reads, or HTML injection surfaces.

Known limitation: the built-in in-memory rate limiter is per process/runtime instance. Use platform-level rate limiting for global protection in production.

## Endpoints

### `GET /health`

Returns:

```json
{
  "status": "ok"
}
```

### `POST /sort-ticket`

Request:

```json
{
  "ticket_id": "T-001",
  "channel": "app",
  "locale": "en",
  "message": "I sent 5000 taka to a wrong number this morning, please help me get it back"
}
```

Response:

```json
{
  "ticket_id": "T-001",
  "case_type": "wrong_transfer",
  "severity": "high",
  "department": "dispute_resolution",
  "agent_summary": "Customer reports sending 5000 BDT to the wrong recipient and requests recovery assistance.",
  "human_review_required": false,
  "confidence": 0.82
}
```

## Local Runbook

Detailed setup guides:

- [Local setup](docs/local-setup.md)
- [Docker setup](docs/docker.md)
- [Vercel hosting](docs/vercel.md)
- [Local benchmarks](docs/benchmarks.md)

The benchmark suite includes the deployed Bun + Hono implementation plus optional Bun + Elysia, Rust Axum, Rust Actix Web, Go, Node.js Express, and Python comparison servers. It can measure minimal routing, the real ticket classifier, JSON parse/serialize work, and CPU-bound checksum work.

Quick start with Bun:

```bash
bun install
bun run dev
```

The service will run at `http://localhost:3000`.

Check the service:

```bash
curl http://localhost:3000/health
curl -X POST http://localhost:3000/sort-ticket \
  -H 'Content-Type: application/json' \
  -d '{"ticket_id":"T-001","channel":"app","locale":"en","message":"Someone called asking my OTP, is that bKash?"}'
```

## Tests

```bash
bun test
npm run typecheck
bun audit --json
```

## LLM Usage

No LLM is used. The classifier is deterministic keyword and rule based.

## Safety

The `agent_summary` is generated from fixed templates and never asks customers to share PIN, OTP, password, or full card numbers.
