# Vercel Hosting

This project can be hosted on Vercel from GitHub.

## Recommended: Vercel GitHub Import

1. Push this repository to GitHub.
2. Open Vercel and choose **Add New Project**.
3. Import the GitHub repository.
4. Keep the default framework/build settings unless Vercel asks for a command.
5. Deploy.
6. Verify:

```bash
curl https://YOUR-APP.vercel.app/health
```

## Docker on Vercel

Vercel's standard Hono deployment is the simpler path. If you intentionally want Docker-based deployment, use a Vercel-compatible container workflow or deploy the Docker image to a container platform. The included `Dockerfile` is portable and tested locally, but Vercel projects commonly run Hono directly from the default exported app instead of running a custom container.

## Post-Deploy Check

```bash
curl -X POST https://YOUR-APP.vercel.app/sort-ticket \
  -H 'Content-Type: application/json' \
  -d '{"ticket_id":"T-001","channel":"app","locale":"en","message":"I sent 3000 to wrong number"}'
```

Expected key fields:

```json
{
  "ticket_id": "T-001",
  "case_type": "wrong_transfer",
  "severity": "high",
  "department": "dispute_resolution"
}
```

## Production Note

The app includes an in-memory rate limiter as a backstop. On Vercel or any multi-instance deployment, configure platform-level, CDN, or gateway rate limiting for global protection.
