# Benchmarking

The deployed Bun + Hono app is the primary implementation. The `rust-version/` and `go-version/` folders are optional local comparison implementations and are not meant for deployment.

## Implementations

- `bun-hono`: current production app, started with `bun run start`
- `rust-axum`: Rust comparison server, started with Cargo
- `go-stdlib`: Go comparison server, started with `go run`

## Run

```bash
npm run benchmark
```

The script starts each available implementation on a different local port:

- Bun: `3000`
- Rust: `3001`
- Go: `3002`

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

- The script disables Bun's local rate limiter with `QUEUESTORM_DISABLE_RATE_LIMIT=1` so the benchmark measures classifier/server throughput instead of intentionally producing `429` responses.
- Missing runtimes are skipped. For example, if Go is not installed, the Go benchmark will be reported as skipped.
- Do not run this script against the deployed Vercel URL.
- Memory measurements are approximate and OS-specific. They are best used for local comparisons on the same machine, not as absolute production sizing numbers.
