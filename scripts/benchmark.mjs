#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { once } from 'node:events'

const totalRequests = Number.parseInt(process.env.REQUESTS ?? '1000', 10)
const concurrency = Number.parseInt(process.env.CONCURRENCY ?? '25', 10)
const warmupRequests = Number.parseInt(process.env.WARMUP_REQUESTS ?? '50', 10)

const implementations = [
  {
    name: 'bun-hono',
    port: 3000,
    command: 'bun',
    args: ['run', 'start'],
    env: { QUEUESTORM_DISABLE_RATE_LIMIT: '1' },
  },
  {
    name: 'rust-axum',
    port: 3001,
    command: 'cargo',
    args: ['run', '--release', '--manifest-path', 'rust-version/Cargo.toml'],
    env: {},
  },
  {
    name: 'go-stdlib',
    port: 3002,
    command: 'go',
    args: ['run', './go-version'],
    env: {},
  },
]

const sampleTickets = [
  'I sent 3000 to wrong number',
  'Payment failed but balance deducted',
  'Someone called asking my OTP, is that bKash?',
  'Please refund my last transaction, I changed my mind',
  'App crashed when I opened it',
]

const results = []

for (const implementation of implementations) {
  if (!(await commandExists(implementation.command))) {
    console.log(`Skipping ${implementation.name}: ${implementation.command} is not installed.`)
    continue
  }

  const child = spawn(implementation.command, implementation.args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...implementation.env,
      PORT: String(implementation.port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout.on('data', (chunk) => process.stdout.write(`[${implementation.name}] ${chunk}`))
  child.stderr.on('data', (chunk) => process.stderr.write(`[${implementation.name}] ${chunk}`))

  try {
    await waitForHealth(implementation.port)
    await runWarmup(implementation.port)
    const result = await runBenchmark(implementation)
    results.push(result)
  } finally {
    child.kill('SIGTERM')
    await Promise.race([once(child, 'exit'), sleep(1500)])
    if (!child.killed) {
      child.kill('SIGKILL')
    }
  }
}

if (results.length === 0) {
  console.error('No benchmark targets were available.')
  process.exit(1)
}

console.log('\nBenchmark results')
console.table(
  results.map((result) => ({
    implementation: result.name,
    requests: result.requests,
    concurrency: result.concurrency,
    ok: result.ok,
    errors: result.errors,
    rps: result.rps.toFixed(1),
    avg_ms: result.avgMs.toFixed(2),
    p50_ms: result.p50Ms.toFixed(2),
    p95_ms: result.p95Ms.toFixed(2),
    p99_ms: result.p99Ms.toFixed(2),
  }))
)

async function runWarmup(port) {
  for (let index = 0; index < warmupRequests; index += 1) {
    await postTicket(port, index)
  }
}

async function runBenchmark(implementation) {
  const latencies = []
  let next = 0
  let ok = 0
  let errors = 0
  const startedAt = performance.now()

  async function worker() {
    while (next < totalRequests) {
      const index = next
      next += 1
      const started = performance.now()

      try {
        const response = await postTicket(implementation.port, index)
        if (response.status === 200) {
          ok += 1
        } else {
          errors += 1
        }
      } catch {
        errors += 1
      } finally {
        latencies.push(performance.now() - started)
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  const elapsedSeconds = (performance.now() - startedAt) / 1000
  latencies.sort((a, b) => a - b)

  return {
    name: implementation.name,
    requests: totalRequests,
    concurrency,
    ok,
    errors,
    rps: totalRequests / elapsedSeconds,
    avgMs: latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
  }
}

async function postTicket(port, index) {
  return fetch(`http://127.0.0.1:${port}/sort-ticket`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ticket_id: `T-BENCH-${index}`,
      channel: 'app',
      locale: 'en',
      message: sampleTickets[index % sampleTickets.length],
    }),
  })
}

async function waitForHealth(port) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      if (response.status === 200) {
        return
      }
    } catch {
      // Server is still starting.
    }
    await sleep(250)
  }
  throw new Error(`Timed out waiting for port ${port}`)
}

async function commandExists(command) {
  const child = spawn('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' })
  const [code] = await once(child, 'exit')
  return code === 0
}

function percentile(values, target) {
  if (values.length === 0) {
    return 0
  }

  return values[Math.min(values.length - 1, Math.floor(values.length * target))]
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
