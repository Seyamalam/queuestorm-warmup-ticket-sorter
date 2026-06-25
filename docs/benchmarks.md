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

It warms each server up, sends the same `/sort-ticket` payload mix, and prints throughput and latency percentiles.

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
