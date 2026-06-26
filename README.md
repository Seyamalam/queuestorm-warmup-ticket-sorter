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

### Heavy Combined Workload Averages

These numbers average all four local benchmark workloads together: `health-routing`, `ticket-classify`, `json-shape`, and `cpu-checksum`. Actix Web is also included in the benchmark suite; if dependency fetching is slow, the repository includes Cargo sparse-registry config under `.cargo/config.toml`.

The Python stdlib comparison server was excluded from this heavy combined table because the full run stalled on the CPU-bound checksum workload at this load. It remains in the benchmark suite for lighter comparisons.

Command:

```bash
IMPLEMENTATIONS=bun-hono,bun-elysia,rust-axum,rust-actix,go-stdlib,node-express REQUESTS=50000 CONCURRENCY=250 WARMUP_REQUESTS=1000 npm run benchmark
```

| Implementation | Workloads | Total Requests | Total OK | Errors | Avg RPS | vs Bun | vs Previous | Avg Latency | Avg P95 | Avg P99 | Max Peak RSS |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Bun + Hono | 4 | 200,000 | 200,000 | 0 | 20,828.0 | +0.0% | baseline | 56.69 ms | 61.29 ms | 70.41 ms | 82.0 MB |
| Bun + Elysia | 4 | 200,000 | 200,000 | 0 | 24,771.1 | +18.9% | +18.9% | 55.02 ms | 58.90 ms | 61.56 ms | 119.9 MB |
| Rust + Axum | 4 | 200,000 | 200,000 | 0 | 27,821.8 | +33.6% | +12.3% | 10.48 ms | 15.04 ms | 17.29 ms | 26.6 MB |
| Rust + Actix Web | 4 | 200,000 | 200,000 | 0 | 27,914.4 | +34.0% | +0.3% | 10.41 ms | 14.93 ms | 16.95 ms | 24.1 MB |
| Go stdlib | 4 | 200,000 | 200,000 | 0 | 27,071.1 | +30.0% | -3.0% | 10.72 ms | 15.71 ms | 18.57 ms | 75.5 MB |
| Node.js + Express | 4 | 200,000 | 200,000 | 0 | 23,582.2 | +13.2% | -12.9% | 52.30 ms | 55.70 ms | 73.14 ms | 232.2 MB |

### Result Summary

- **Best overall local throughput:** Rust Actix Web and Rust Axum are the fastest in the heavy combined workload average, with Go close behind.
- **Best memory footprint:** Rust Actix Web and Rust Axum are the clear winners in this heavy local run, peaking at 24.1 MB and 26.6 MB respectively.
- **Best CPU-bound behavior:** Rust and Go pull far ahead on `cpu-checksum`, which is expected because the workload is dominated by tight string/number loops rather than framework routing.
- **Best JavaScript comparison:** Bun + Elysia leads the JavaScript group on average RPS in the heavy run. Node.js + Express is competitive on throughput but uses the most memory. Bun + Hono remains the deployed app because it is already complete, simple, fast enough, and fits the Vercel workflow.
- **Python stdlib limitation:** The Python comparison is intentionally dependency-free and uses `ThreadingHTTPServer`, which is not a production high-concurrency server. It did not complete the heavy CPU-bound run in practical time, which is why the heavy table excludes it.
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
