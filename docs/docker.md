# Docker Setup

Docker is optional. It is useful for local replication or platforms that can run a container image.

## Build

```bash
docker build -t queuestorm-warmup-ticket-sorter .
```

## Run

```bash
docker run --rm -p 3000:3000 queuestorm-warmup-ticket-sorter
```

## Smoke Test

```bash
curl http://localhost:3000/health

curl -X POST http://localhost:3000/sort-ticket \
  -H 'Content-Type: application/json' \
  -d '{"ticket_id":"T-001","message":"Someone called asking my OTP, is that bKash?"}'
```

## Notes

- The image uses `oven/bun:1.3.13-alpine`.
- The container listens on port `3000`.
- No secrets or environment variables are required for classification.
- The built-in rate limiter is in-memory and per container instance.
