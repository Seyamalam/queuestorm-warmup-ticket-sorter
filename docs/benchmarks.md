# Benchmarking

The deployed Bun + Hono app is the primary implementation. The `rust-version/`, `go-version/`, and `python-version/` folders are optional local comparison implementations and are not meant for deployment.

## Implementations

- `bun-hono`: current production app, started with `bun run start`
- `rust-axum`: Rust comparison server, started with Cargo
- `go-stdlib`: Go comparison server, started with `go run`
- `python-stdlib`: Python comparison server, started with `python3`

## Run

```bash
npm run benchmark
```

The script starts each available implementation on a different local port:

- Bun: `3000`
- Rust: `3001`
- Go: `3002`
- Python: `3003`

## Workloads

The benchmark measures several API shapes so the result shows which runtime works well for which objective:

- `health-routing`: `GET /health`, minimal routing plus tiny JSON response.
- `ticket-classify`: `POST /sort-ticket`, the actual CRM classifier workload.
- `json-shape`: `POST /bench/json`, parses a structured JSON payload, aggregates fields, and serializes a summary.
- `cpu-checksum`: `POST /bench/cpu`, runs a deterministic string checksum loop to show CPU-bound behavior.

It benchmarks one implementation at a time:

1. Start one local server.
2. Wait for `/health`.
3. Warm up `/sort-ticket`.
4. Benchmark `/sort-ticket`.
5. Sample process-tree RSS memory during the run.
6. Stop the server and clear the port.
7. Move to the next implementation.

The output table includes:

- `rps`: requests per second
- `vs_bun`: throughput delta compared with the Bun + Hono baseline
- `vs_prev`: throughput delta compared with the previous row
- `avg_ms`, `p50_ms`, `p95_ms`, `p99_ms`: latency stats
- `peak_rss_mb`: peak resident memory for the server process tree during the run
- `end_rss_mb`: resident memory near the end of the measured run

## Options

```bash
REQUESTS=2000 CONCURRENCY=50 WARMUP_REQUESTS=100 npm run benchmark
```

Defaults:

- `REQUESTS=1000`
- `CONCURRENCY=25`
- `WARMUP_REQUESTS=50`

## Notes

- The script disables Bun's local rate limiter with `QUEUESTORM_DISABLE_RATE_LIMIT=1` so the benchmark measures server/workload throughput instead of intentionally producing `429` responses.
- Missing runtimes are skipped. For example, if Go is not installed, the Go benchmark will be reported as skipped.
- The Python comparison version uses only the standard library, so it does not require FastAPI, Flask, or Uvicorn.
- Do not run this script against the deployed Vercel URL.
- Memory measurements are approximate and OS-specific. They are best used for local comparisons on the same machine, not as absolute production sizing numbers.
