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
    cwd: process.cwd(),
    env: { QUEUESTORM_DISABLE_RATE_LIMIT: '1' },
  },
  {
    name: 'rust-axum',
    port: 3001,
    command: 'cargo',
    args: ['run', '--release', '--manifest-path', 'rust-version/Cargo.toml'],
    cwd: process.cwd(),
    env: {},
  },
  {
    name: 'go-stdlib',
    port: 3002,
    command: 'go',
    args: ['run', '.'],
    cwd: new URL('../go-version/', import.meta.url).pathname,
    env: {},
  },
  {
    name: 'python-stdlib',
    port: 3003,
    command: 'python3',
    args: ['main.py'],
    cwd: new URL('../python-version/', import.meta.url).pathname,
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
    cwd: implementation.cwd,
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
    console.log(`\nStarting ${implementation.name} on port ${implementation.port}`)
    await waitForHealth(implementation.port)
    await runWarmup(implementation.port)
    const result = await runBenchmark(implementation, child)
    results.push(result)
  } finally {
    await stopServer(child, implementation.name, implementation.port)
  }
}

if (results.length === 0) {
  console.error('No benchmark targets were available.')
  process.exit(1)
}

console.log('\nBenchmark results')
const baseline = results[0]
console.table(
  results.map((result, index) => {
    const previous = results[index - 1]

    return {
      implementation: result.name,
      requests: result.requests,
      concurrency: result.concurrency,
      ok: result.ok,
      errors: result.errors,
      rps: result.rps.toFixed(1),
      vs_bun: formatPercentDelta(result.rps, baseline.rps),
      vs_prev: previous ? formatPercentDelta(result.rps, previous.rps) : 'baseline',
      avg_ms: result.avgMs.toFixed(2),
      p50_ms: result.p50Ms.toFixed(2),
      p95_ms: result.p95Ms.toFixed(2),
      p99_ms: result.p99Ms.toFixed(2),
      peak_rss_mb: formatMb(result.peakRssBytes),
      end_rss_mb: formatMb(result.endRssBytes),
    }
  })
)

async function runWarmup(port) {
  for (let index = 0; index < warmupRequests; index += 1) {
    await postTicket(port, index)
  }
}

async function runBenchmark(implementation, child) {
  const latencies = []
  let next = 0
  let ok = 0
  let errors = 0
  let peakRssBytes = await processTreeRssBytes(child.pid, implementation.port)
  let keepSamplingMemory = true
  const memorySampler = sampleMemory(child.pid, (rssBytes) => {
    if (rssBytes > peakRssBytes) {
      peakRssBytes = rssBytes
    }
  }).finally(() => {
    keepSamplingMemory = false
  })
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
  keepSamplingMemory = false
  await memorySampler
  const endRssBytes = await processTreeRssBytes(child.pid, implementation.port)

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
    peakRssBytes,
    endRssBytes,
  }

  async function sampleMemory(pid, onSample) {
    while (keepSamplingMemory) {
      onSample(await processTreeRssBytes(pid, implementation.port))
      await sleep(100)
    }
    onSample(await processTreeRssBytes(pid, implementation.port))
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

async function stopServer(child, name, port) {
  console.log(`Stopping ${name}`)
  await killProcessTree(child.pid, 'SIGTERM')
  await Promise.race([once(child, 'exit'), sleep(1500)])
  if (child.exitCode === null) {
    await killProcessTree(child.pid, 'SIGKILL')
    await Promise.race([once(child, 'exit'), sleep(1500)])
  }

  await killPortListeners(port)
}

async function processTreeRssBytes(pid, port) {
  const pids = new Set(await descendantPids(pid))
  if (pid) {
    pids.add(pid)
  }

  for (const listenerPid of await listenerPids(port)) {
    pids.add(listenerPid)
    for (const descendant of await descendantPids(listenerPid)) {
      pids.add(descendant)
    }
  }

  let total = 0
  for (const currentPid of pids) {
    total += await processRssBytes(currentPid)
  }

  return total
}

async function descendantPids(rootPid) {
  const output = await commandOutput('ps', ['-axo', 'pid=,ppid='])
  const children = new Map()

  for (const line of output.trim().split('\n')) {
    const [pidRaw, ppidRaw] = line.trim().split(/\s+/)
    const pid = Number.parseInt(pidRaw, 10)
    const ppid = Number.parseInt(ppidRaw, 10)
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) {
      continue
    }

    const entries = children.get(ppid) ?? []
    entries.push(pid)
    children.set(ppid, entries)
  }

  const descendants = []
  const queue = [...(children.get(rootPid) ?? [])]
  while (queue.length > 0) {
    const pid = queue.shift()
    descendants.push(pid)
    queue.push(...(children.get(pid) ?? []))
  }

  return descendants
}

async function killProcessTree(pid, signal) {
  if (!pid) {
    return
  }

  const pids = await descendantPids(pid)
  pids.push(pid)

  for (const currentPid of pids.reverse()) {
    try {
      process.kill(currentPid, signal)
    } catch {
      // Process already exited.
    }
  }
}

async function killPortListeners(port) {
  const pids = await listenerPids(port)

  for (const pid of pids) {
    await killProcessTree(pid, 'SIGTERM')
  }

  if (pids.length > 0) {
    await sleep(500)
  }

  for (const pid of pids) {
    try {
      process.kill(pid, 0)
      await killProcessTree(pid, 'SIGKILL')
    } catch {
      // Process already exited.
    }
  }
}

async function listenerPids(port) {
  const output = await commandOutput('lsof', [
    '-tiTCP:' + String(port),
    '-sTCP:LISTEN',
    '-nP',
  ])

  return output
    .trim()
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter(Number.isFinite)
}

async function processRssBytes(pid) {
  if (!pid) {
    return 0
  }

  const output = await commandOutput('ps', ['-o', 'rss=', '-p', String(pid)])
  const rssKb = Number.parseInt(output.trim(), 10)
  return Number.isFinite(rssKb) ? rssKb * 1024 : 0
}

async function commandOutput(command, args) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] })
  const chunks = []
  child.stdout.on('data', (chunk) => chunks.push(chunk))
  await once(child, 'exit')
  return Buffer.concat(chunks).toString('utf8')
}

function formatPercentDelta(value, baselineValue) {
  if (!baselineValue) {
    return 'n/a'
  }

  const delta = ((value - baselineValue) / baselineValue) * 100
  const sign = delta >= 0 ? '+' : ''
  return `${sign}${delta.toFixed(1)}%`
}

function formatMb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
