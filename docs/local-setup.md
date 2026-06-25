# Local Setup

Use this path for development, testing, and quick manual checks.

## Requirements

- Bun 1.3 or newer

## Install

```bash
bun install
```

## Run

```bash
bun run dev
```

The API runs at `http://localhost:3000`.

## Smoke Test

```bash
curl http://localhost:3000/health

curl -X POST http://localhost:3000/sort-ticket \
  -H 'Content-Type: application/json' \
  -d '{"ticket_id":"T-001","channel":"app","locale":"en","message":"Payment failed but balance deducted"}'
```

## Verification

```bash
bun test
npm run typecheck
bun audit --json
```
