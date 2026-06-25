#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { once } from 'node:events'

const totalRequests = Number.parseInt(process.env.REQUESTS ?? '1000', 10)
const concurrency = Number.parseInt(process.env.CONCURRENCY ?? '25', 10)
const warmupRequests = Number.parseInt(process.env.WARMUP_REQUESTS ?? '50', 10)
const selectedImplementations = new Set(
  (process.env.IMPLEMENTATIONS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
)

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
    name: 'rust-actix',
    port: 3004,
    command: 'cargo',
    args: ['run', '--release', '--manifest-path', 'actix-version/Cargo.toml'],
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
    name: 'node-express',
    port: 3005,
    command: 'npm',
    args: ['start', '--silent'],
    cwd: new URL('../express-version/', import.meta.url).pathname,
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

const activeImplementations =
  selectedImplementations.size > 0
    ? implementations.filter((implementation) => selectedImplementations.has(implementation.name))
    : implementations

const sampleTickets = [
  'I sent 3000 to wrong number',
  'Payment failed but balance deducted',
  'Someone called asking my OTP, is that bKash?',
  'Please refund my last transaction, I changed my mind',
  'App crashed when I opened it',
]

const jsonItems = Array.from({ length: 24 }, (_, index) => ({
  id: index + 1,
  amount: 100 + index * 3.25,
  label: `merchant-${index % 6}-invoice-${index}`,
  active: index % 3 !== 0,
}))

const cpuText = Array.from({ length: 64 }, (_, index) => `QueueStorm-${index}-ভুল-OTP-refund`).join('|')

const workloads = [
  {
    name: 'health-routing',
    objective: 'Minimal routing and JSON response',
    request: (port) => fetch(`http://127.0.0.1:${port}/health`),
  },
  {
    name: 'ticket-classify',
    objective: 'Realistic CRM classification',
    request: (port, index) => postJson(port, '/sort-ticket', {
      ticket_id: `T-BENCH-${index}`,
      channel: 'app',
      locale: 'en',
      message: sampleTickets[index % sampleTickets.length],
    }),
  },
  {
    name: 'json-shape',
    objective: 'JSON parse, aggregate, serialize',
    request: (port, index) => postJson(port, '/bench/json', {
      batch_id: `B-${index}`,
      source: 'benchmark',
      items: jsonItems,
    }),
  },
  {
    name: 'cpu-checksum',
    objective: 'CPU-bound string checksum',
    request: (port, index) => postJson(port, '/bench/cpu', {
      text: `${cpuText}-${index % 17}`,
      rounds: 400,
    }),
  },
]

const results = []

for (const implementation of activeImplementations) {
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
    await waitForHealth(implementation.port, child)
    for (const workload of workloads) {
      await runWarmup(implementation.port, workload)
      const result = await runBenchmark(implementation, child, workload)
      results.push(result)
    }
  } catch (error) {
    console.log(`Skipping ${implementation.name}: ${error.message}`)
  } finally {
    await stopServer(child, implementation.name, implementation.port)
  }
}

if (results.length === 0) {
  console.error('No benchmark targets were available.')
  process.exit(1)
}

console.log('\nBenchmark results')
const baselineByWorkload = new Map()
console.table(
  results.map((result, index) => {
    if (!baselineByWorkload.has(result.workload)) {
      baselineByWorkload.set(result.workload, result)
    }
    const baseline = baselineByWorkload.get(result.workload)
    const previous = previousForWorkload(results, result.workload, index)

    return {
      implementation: result.name,
      workload: result.workload,
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

const overallResults = summarizeOverall(results)
const overallBaseline = overallResults[0]
console.log('\nOverall averages across workloads')
console.table(
  overallResults.map((result, index) => {
    const previous = overallResults[index - 1]

    return {
      implementation: result.name,
      workloads: result.workloads,
      total_requests: result.totalRequests,
      total_ok: result.totalOk,
      total_errors: result.totalErrors,
      avg_rps: result.avgRps.toFixed(1),
      vs_bun: formatPercentDelta(result.avgRps, overallBaseline.avgRps),
      vs_prev: previous ? formatPercentDelta(result.avgRps, previous.avgRps) : 'baseline',
      avg_latency_ms: result.avgLatencyMs.toFixed(2),
      avg_p95_ms: result.avgP95Ms.toFixed(2),
      avg_p99_ms: result.avgP99Ms.toFixed(2),
      max_peak_rss_mb: formatMb(result.maxPeakRssBytes),
    }
  })
)

async function runWarmup(port, workload) {
  for (let index = 0; index < warmupRequests; index += 1) {
    await workload.request(port, index)
  }
}

async function runBenchmark(implementation, child, workload) {
  console.log(`Benchmarking ${implementation.name} :: ${workload.name} (${workload.objective})`)
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
        const response = await workload.request(implementation.port, index)
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
    workload: workload.name,
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

async function postJson(port, path, body) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before /health was ready`)
    }

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

function previousForWorkload(results, workload, currentIndex) {
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    if (results[index].workload === workload) {
      return results[index]
    }
  }

  return null
}

function summarizeOverall(results) {
  const grouped = new Map()

  for (const result of results) {
    const current =
      grouped.get(result.name) ??
      {
        name: result.name,
        workloads: 0,
        totalRequests: 0,
        totalOk: 0,
        totalErrors: 0,
        rpsTotal: 0,
        avgLatencyTotal: 0,
        p95Total: 0,
        p99Total: 0,
        maxPeakRssBytes: 0,
      }

    current.workloads += 1
    current.totalRequests += result.requests
    current.totalOk += result.ok
    current.totalErrors += result.errors
    current.rpsTotal += result.rps
    current.avgLatencyTotal += result.avgMs
    current.p95Total += result.p95Ms
    current.p99Total += result.p99Ms
    current.maxPeakRssBytes = Math.max(current.maxPeakRssBytes, result.peakRssBytes)
    grouped.set(result.name, current)
  }

  return [...grouped.values()].map((result) => ({
    name: result.name,
    workloads: result.workloads,
    totalRequests: result.totalRequests,
    totalOk: result.totalOk,
    totalErrors: result.totalErrors,
    avgRps: result.rpsTotal / result.workloads,
    avgLatencyMs: result.avgLatencyTotal / result.workloads,
    avgP95Ms: result.p95Total / result.workloads,
    avgP99Ms: result.p99Total / result.workloads,
    maxPeakRssBytes: result.maxPeakRssBytes,
  }))
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
