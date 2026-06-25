import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { secureHeaders } from 'hono/secure-headers'
import { timeout } from 'hono/timeout'
import type { MiddlewareHandler } from 'hono'

export type CaseType =
  | 'wrong_transfer'
  | 'payment_failed'
  | 'refund_request'
  | 'phishing_or_social_engineering'
  | 'other'

export type Severity = 'low' | 'medium' | 'high' | 'critical'

export type Department =
  | 'customer_support'
  | 'dispute_resolution'
  | 'payments_ops'
  | 'fraud_risk'

type TicketRequest = {
  ticket_id?: unknown
  channel?: unknown
  locale?: unknown
  message?: unknown
}

type RateLimitState = {
  count: number
  resetAt: number
}

export type TicketResponse = {
  ticket_id: string
  case_type: CaseType
  severity: Severity
  department: Department
  agent_summary: string
  human_review_required: boolean
  confidence: number
}

const allowedChannels = new Set(['app', 'sms', 'call_center', 'merchant_portal'])
const allowedLocales = new Set(['bn', 'en', 'mixed'])

const caseOrder = [
  'phishing_or_social_engineering',
  'wrong_transfer',
  'payment_failed',
  'refund_request',
] as const

const keywords: Record<(typeof caseOrder)[number], readonly string[]> = {
  phishing_or_social_engineering: [
    'scam',
    'scammer',
    'fraud',
    'fake',
    'phishing',
    'suspicious',
    'called me',
    'someone called',
    'phone call',
    'unknown number',
    'sms',
    'message from',
    'sent me a link',
    'asking my',
    'asked for',
    'asks for',
    'asking for',
    'wants my',
    'account locked',
    'পুরস্কার',
    'প্রতারক',
    'ভুয়া',
  ],
  wrong_transfer: [
    'wrong number',
    'wrong recipient',
    'wrong account',
    'wrong person',
    'mistakenly sent',
    'mistake transfer',
    'sent by mistake',
    'sent money to wrong',
    'accidental transfer',
    'recover money',
    'get it back',
    'ভুল নাম্বার',
    'ভুল নম্বর',
    'ভুলে পাঠিয়েছি',
    'ভুলে টাকা',
    'ফিরত চাই',
  ],
  payment_failed: [
    'payment failed',
    'transaction failed',
    'failed payment',
    'balance deducted',
    'money deducted',
    'amount deducted',
    'charged but',
    'debited',
    'merchant did not receive',
    'order failed',
    'cashout failed',
    'send money failed',
    'failed but',
    'পেমেন্ট ফেল',
    'লেনদেন ব্যর্থ',
    'টাকা কেটে',
    'ব্যালেন্স কেটে',
  ],
  refund_request: [
    'refund',
    'return my money',
    'money back',
    'cancel transaction',
    'changed my mind',
    'reverse transaction',
    'reversal',
    'ফেরত',
    'রিফান্ড',
    'টাকা ফেরত',
    'বাতিল',
  ],
}

const urgentWords = [
  'urgent',
  'immediately',
  'emergency',
  'account hacked',
  'lost all',
  'cannot access',
  'unauthorized',
  'now',
  'জরুরি',
  'হ্যাক',
] as const

const contestedRefundWords = ['dispute', 'unauthorized', 'charged twice', 'double charged'] as const

const credentialWords = [
  'otp',
  'pin',
  'password',
  'passcode',
  'verification code',
  'security code',
  'cvv',
  'card number',
  'ওটিপি',
  'পিন',
  'পাসওয়ার্ড',
] as const

const credentialRiskContextWords = [
  'ask',
  'asked',
  'asking',
  'asks',
  'want',
  'wants',
  'wanted',
  'called',
  'call',
  'sms',
  'link',
  'fake',
  'scam',
  'scammer',
  'fraud',
  'phishing',
  'suspicious',
  'ভুয়া',
  'প্রতারক',
  'জানতে',
  'চেয়েছে',
] as const

const summaries: Record<CaseType, string> = {
  wrong_transfer: 'Customer reports sending{amount} to the wrong recipient and requests recovery assistance.',
  payment_failed: 'Customer reports a failed payment or transaction where balance may have been deducted.',
  refund_request: 'Customer requests a refund or reversal for a previous transaction.',
  phishing_or_social_engineering:
    'Customer reports a suspicious contact or possible credential-targeting attempt that needs fraud review.',
  other:
    'Customer reports a general issue that does not match payment, refund, transfer, or fraud categories.',
}

const highAmountPattern = /(?:৳|tk|taka|bdt)?\s*(\d{4,7})(?:\s*(?:tk|taka|bdt|টাকা))?/gi
const maxBodyBytes = 8 * 1024
const requestTimeoutMs = 25_000
const rateLimitWindowMs = 60_000
const rateLimitStore = new Map<string, RateLimitState>()

export const app = new Hono()

app.use('*', secureHeaders())
app.use('*', timeout(requestTimeoutMs))
app.use(
  '*',
  bodyLimit({
    maxSize: maxBodyBytes,
    onError: (c) => c.json({ error: 'Request body is too large.' }, 413),
  })
)
app.use('*', rateLimit({ limit: 600, windowMs: rateLimitWindowMs, namespace: 'global' }))
app.use('/health', rateLimit({ limit: 300, windowMs: rateLimitWindowMs, namespace: 'health' }))
app.use(
  '/sort-ticket',
  rateLimit({ limit: 120, windowMs: rateLimitWindowMs, namespace: 'sort-ticket' })
)

app.get('/health', (c) => c.json({ status: 'ok' }))

app.post('/sort-ticket', async (c) => {
  let body: TicketRequest

  try {
    body = await c.req.json<TicketRequest>()
  } catch {
    return c.json({ error: 'Request body must be valid JSON.' }, 400)
  }

  const validationError = validateTicket(body)
  if (validationError) {
    return c.json({ error: validationError }, 400)
  }

  return c.json(sortTicket(body as { ticket_id: string; message: string }))
})

app.notFound((c) => c.json({ error: 'Not found.' }, 404))

app.onError((error, c) => {
  console.error(error)
  return c.json({ error: 'Internal server error.' }, 500)
})

export function clearRateLimitStore(): void {
  rateLimitStore.clear()
}

function rateLimit(options: { limit: number; windowMs: number; namespace: string }): MiddlewareHandler {
  return async (c, next) => {
    if (process.env.QUEUESTORM_DISABLE_RATE_LIMIT === '1') {
      await next()
      return
    }

    const now = Date.now()
    const key = `${options.namespace}:${clientIdentifier(c.req.raw)}:${c.req.path}`
    const current = rateLimitStore.get(key)
    const state =
      current && current.resetAt > now ? current : { count: 0, resetAt: now + options.windowMs }

    state.count += 1
    rateLimitStore.set(key, state)
    pruneExpiredRateLimits(now)

    const remaining = Math.max(0, options.limit - state.count)
    const resetSeconds = Math.ceil((state.resetAt - now) / 1000)

    c.header('X-RateLimit-Limit', String(options.limit))
    c.header('X-RateLimit-Remaining', String(remaining))
    c.header('X-RateLimit-Reset', String(resetSeconds))

    if (state.count > options.limit) {
      c.header('Retry-After', String(resetSeconds))
      return c.json({ error: 'Too many requests.' }, 429)
    }

    await next()
  }
}

function clientIdentifier(request: Request): string {
  const forwardedFor = request.headers.get('x-forwarded-for')
  if (forwardedFor) {
    return forwardedFor.split(',', 1)[0].trim() || 'unknown'
  }

  return request.headers.get('x-real-ip') ?? 'unknown'
}

function pruneExpiredRateLimits(now: number): void {
  if (rateLimitStore.size < 1_000) {
    return
  }

  for (const [key, state] of rateLimitStore) {
    if (state.resetAt <= now) {
      rateLimitStore.delete(key)
    }
  }
}

export function validateTicket(body: TicketRequest): string | null {
  if (typeof body.ticket_id !== 'string' || body.ticket_id.trim() === '') {
    return 'ticket_id is required and must be a non-empty string.'
  }

  if (typeof body.message !== 'string' || body.message.trim() === '') {
    return 'message is required and must be a non-empty string.'
  }

  if (body.channel !== undefined && !isAllowedOptionalEnum(body.channel, allowedChannels)) {
    return 'channel must be one of: app, sms, call_center, merchant_portal.'
  }

  if (body.locale !== undefined && !isAllowedOptionalEnum(body.locale, allowedLocales)) {
    return 'locale must be one of: bn, en, mixed.'
  }

  return null
}

function isAllowedOptionalEnum(value: unknown, allowed: Set<string>): boolean {
  return typeof value === 'string' && allowed.has(value)
}

export function sortTicket(ticket: { ticket_id: string; message: string }): TicketResponse {
  const message = normalize(ticket.message)
  const amount = extractAmount(message)
  const { caseType, confidence } = classifyCase(message)
  const severity = determineSeverity(caseType, message, amount)

  return {
    ticket_id: ticket.ticket_id,
    case_type: caseType,
    severity,
    department: departmentFor(caseType, severity),
    agent_summary: makeSummary(caseType, amount),
    human_review_required: caseType === 'phishing_or_social_engineering' || severity === 'critical',
    confidence: roundConfidence(confidence),
  }
}

export function normalize(text: string): string {
  return text.toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

export function extractAmount(message: string): number | null {
  let maxAmount: number | null = null
  const normalized = message.replace(/,/g, '')
  let match: RegExpExecArray | null

  highAmountPattern.lastIndex = 0
  while ((match = highAmountPattern.exec(normalized)) !== null) {
    const amount = Number.parseInt(match[1], 10)
    if (Number.isFinite(amount) && (maxAmount === null || amount > maxAmount)) {
      maxAmount = amount
    }
  }

  return maxAmount
}

export function classifyCase(message: string): { caseType: CaseType; confidence: number } {
  let bestCase: Exclude<CaseType, 'other'> = 'wrong_transfer'
  let bestScore = 0
  let phishingScore = 0
  const credentialScore = keywordListScore(message, credentialWords)

  for (const caseType of caseOrder) {
    const score = keywordScore(message, caseType)

    if (caseType === 'phishing_or_social_engineering') {
      phishingScore = score
    }

    if (score > bestScore) {
      bestCase = caseType
      bestScore = score
    }
  }

  if (credentialScore > 0 && hasAny(message, credentialRiskContextWords)) {
    phishingScore += credentialScore
  }

  if (phishingScore > 0) {
    return {
      caseType: 'phishing_or_social_engineering',
      confidence: Math.min(0.98, 0.78 + phishingScore * 0.05),
    }
  }

  if (bestScore === 0) {
    return { caseType: 'other', confidence: 0.55 }
  }

  return { caseType: bestCase, confidence: Math.min(0.95, 0.68 + bestScore * 0.07) }
}

function keywordScore(message: string, caseType: Exclude<CaseType, 'other'>): number {
  return keywordListScore(message, keywords[caseType])
}

function keywordListScore(message: string, list: readonly string[]): number {
  let score = 0

  for (const keyword of list) {
    if (message.includes(keyword)) {
      score += 1
    }
  }

  return score
}

export function determineSeverity(
  caseType: CaseType,
  message: string,
  amount: number | null
): Severity {
  if (caseType === 'phishing_or_social_engineering') {
    return 'critical'
  }

  if (hasAny(message, urgentWords)) {
    return 'high'
  }

  if (caseType === 'wrong_transfer' || caseType === 'payment_failed') {
    return 'high'
  }

  if (caseType === 'refund_request') {
    if (amount !== null && amount >= 10_000) {
      return 'medium'
    }

    return hasAny(message, contestedRefundWords) ? 'medium' : 'low'
  }

  return 'low'
}

function hasAny(message: string, words: readonly string[]): boolean {
  for (const word of words) {
    if (message.includes(word)) {
      return true
    }
  }

  return false
}

export function departmentFor(caseType: CaseType, severity: Severity): Department {
  if (caseType === 'phishing_or_social_engineering') {
    return 'fraud_risk'
  }

  if (caseType === 'payment_failed') {
    return 'payments_ops'
  }

  if (caseType === 'wrong_transfer') {
    return 'dispute_resolution'
  }

  if (caseType === 'refund_request' && severity !== 'low') {
    return 'dispute_resolution'
  }

  return 'customer_support'
}

export function makeSummary(caseType: CaseType, amount: number | null): string {
  if (caseType !== 'wrong_transfer') {
    return summaries[caseType]
  }

  const amountText = amount !== null ? ` ${amount} BDT` : ''
  return summaries.wrong_transfer.replace('{amount}', amountText)
}

function roundConfidence(confidence: number): number {
  return Math.round(confidence * 100) / 100
}

export default app
