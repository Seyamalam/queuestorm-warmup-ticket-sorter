import { beforeEach, describe, expect, it } from 'bun:test'

import app, {
  classifyCase,
  clearRateLimitStore,
  departmentFor,
  determineSeverity,
  extractAmount,
  makeSummary,
  normalize,
  sortTicket,
  validateTicket,
  type CaseType,
  type Department,
  type Severity,
  type TicketResponse,
} from './index'

const caseTypes = new Set<CaseType>([
  'wrong_transfer',
  'payment_failed',
  'refund_request',
  'phishing_or_social_engineering',
  'other',
])

const severities = new Set<Severity>(['low', 'medium', 'high', 'critical'])

const departments = new Set<Department>([
  'customer_support',
  'dispute_resolution',
  'payments_ops',
  'fraud_risk',
])

const sensitiveRequestPhrases = [
  'share otp',
  'share pin',
  'share password',
  'send otp',
  'send pin',
  'send password',
  'provide otp',
  'provide pin',
  'provide password',
  'give otp',
  'give pin',
  'give password',
  'full card number',
] as const

type ExpectedClassification = {
  message: string
  caseType: CaseType
  severity: Severity
  department: Department
  review: boolean
}

async function postSortTicket(body: unknown) {
  return app.fetch(
    new Request('http://localhost/sort-ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  )
}

async function sort(message: string, ticketId = 'T-001'): Promise<TicketResponse> {
  const response = await postSortTicket({
    ticket_id: ticketId,
    channel: 'app',
    locale: 'en',
    message,
  })

  expect(response.status).toBe(200)
  return response.json()
}

function expectResponseSchema(result: TicketResponse, ticketId: string): void {
  expect(Object.keys(result).sort()).toEqual([
    'agent_summary',
    'case_type',
    'confidence',
    'department',
    'human_review_required',
    'severity',
    'ticket_id',
  ])
  expect(result.ticket_id).toBe(ticketId)
  expect(caseTypes.has(result.case_type)).toBe(true)
  expect(severities.has(result.severity)).toBe(true)
  expect(departments.has(result.department)).toBe(true)
  expect(typeof result.agent_summary).toBe('string')
  expect(result.agent_summary.length).toBeGreaterThan(20)
  expect(result.agent_summary.split(/[.!?]/).filter(Boolean).length).toBeLessThanOrEqual(2)
  expect(typeof result.human_review_required).toBe('boolean')
  expect(result.confidence).toBeGreaterThanOrEqual(0)
  expect(result.confidence).toBeLessThanOrEqual(1)
}

describe('HTTP contract', () => {
  beforeEach(() => {
    clearRateLimitStore()
  })

  it('returns the required /health response quickly', async () => {
    const startedAt = performance.now()
    const response = await app.fetch(new Request('http://localhost/health'))
    const elapsedMs = performance.now() - startedAt

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
    expect(elapsedMs).toBeLessThan(10_000)
    expect(response.headers.get('x-ratelimit-limit')).toBe('300')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('returns the exact required response shape and echoes ticket_id', async () => {
    const result = await sort(
      'I sent 5000 taka to a wrong number this morning, please help me get it back',
      'T-REQ-001'
    )

    expectResponseSchema(result, 'T-REQ-001')
    expect(result).toEqual({
      ticket_id: 'T-REQ-001',
      case_type: 'wrong_transfer',
      severity: 'high',
      department: 'dispute_resolution',
      agent_summary:
        'Customer reports sending 5000 BDT to the wrong recipient and requests recovery assistance.',
      human_review_required: false,
      confidence: 0.82,
    })
  })

  it('returns JSON for unknown routes', async () => {
    const response = await app.fetch(new Request('http://localhost/nope'))

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Not found.' })
  })

  it('rejects invalid JSON', async () => {
    const response = await app.fetch(
      new Request('http://localhost/sort-ticket', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{bad json',
      })
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Request body must be valid JSON.' })
  })

  it('rejects oversized request bodies before classification', async () => {
    const response = await postSortTicket({
      ticket_id: 'T-BIG',
      message: 'Payment failed '.repeat(700),
    })

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'Request body is too large.' })
  })

  it('rejects missing or invalid required fields', async () => {
    for (const body of [
      {},
      { ticket_id: '', message: 'Payment failed' },
      { ticket_id: 123, message: 'Payment failed' },
      { ticket_id: 'T-001' },
      { ticket_id: 'T-001', message: '' },
      { ticket_id: 'T-001', message: 123 },
    ]) {
      const response = await postSortTicket(body)
      expect(response.status).toBe(400)
    }
  })

  it('accepts valid optional channel and locale enums', async () => {
    for (const channel of ['app', 'sms', 'call_center', 'merchant_portal']) {
      for (const locale of ['bn', 'en', 'mixed']) {
        const response = await postSortTicket({
          ticket_id: `T-${channel}-${locale}`,
          channel,
          locale,
          message: 'Payment failed but balance deducted',
        })

        expect(response.status).toBe(200)
      }
    }
  })

  it('rejects invalid optional channel and locale values', async () => {
    for (const body of [
      { ticket_id: 'T-001', channel: 'web', message: 'Payment failed' },
      { ticket_id: 'T-001', channel: 42, message: 'Payment failed' },
      { ticket_id: 'T-001', locale: 'fr', message: 'Payment failed' },
      { ticket_id: 'T-001', locale: false, message: 'Payment failed' },
    ]) {
      const response = await postSortTicket(body)
      expect(response.status).toBe(400)
    }
  })

  it('rate limits hot endpoints with retry metadata', async () => {
    let lastOkResponse: Response | null = null

    for (let index = 0; index < 120; index += 1) {
      lastOkResponse = await app.fetch(
        new Request('http://localhost/sort-ticket', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': '203.0.113.10',
          },
          body: JSON.stringify({
            ticket_id: `T-RATE-${index}`,
            message: 'Payment failed but balance deducted',
          }),
        })
      )
      expect(lastOkResponse.status).toBe(200)
    }

    expect(lastOkResponse?.headers.get('x-ratelimit-limit')).toBe('120')
    expect(lastOkResponse?.headers.get('x-ratelimit-remaining')).toBe('0')

    const limited = await app.fetch(
      new Request('http://localhost/sort-ticket', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '203.0.113.10',
        },
        body: JSON.stringify({
          ticket_id: 'T-RATE-LIMITED',
          message: 'Payment failed but balance deducted',
        }),
      })
    )

    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).not.toBeNull()
    expect(await limited.json()).toEqual({ error: 'Too many requests.' })
  })
})

describe('classification requirements', () => {
  const publicSamples: ExpectedClassification[] = [
    {
      message: 'I sent 3000 to wrong number',
      caseType: 'wrong_transfer',
      severity: 'high',
      department: 'dispute_resolution',
      review: false,
    },
    {
      message: 'Payment failed but balance deducted',
      caseType: 'payment_failed',
      severity: 'high',
      department: 'payments_ops',
      review: false,
    },
    {
      message: 'Someone called asking my OTP, is that bKash?',
      caseType: 'phishing_or_social_engineering',
      severity: 'critical',
      department: 'fraud_risk',
      review: true,
    },
    {
      message: 'Please refund my last transaction, I changed my mind',
      caseType: 'refund_request',
      severity: 'low',
      department: 'customer_support',
      review: false,
    },
    {
      message: 'App crashed when I opened it',
      caseType: 'other',
      severity: 'low',
      department: 'customer_support',
      review: false,
    },
  ]

  it('passes every public sample case', async () => {
    for (const sample of publicSamples) {
      const result = await sort(sample.message)

      expect(result.case_type).toBe(sample.caseType)
      expect(result.severity).toBe(sample.severity)
      expect(result.department).toBe(sample.department)
      expect(result.human_review_required).toBe(sample.review)
      expectResponseSchema(result, 'T-001')
    }
  })

  it('covers representative hidden-style wording for each case type', async () => {
    const cases: ExpectedClassification[] = [
      {
        message: 'Mistakenly sent 1200 BDT to the wrong recipient, can you recover money?',
        caseType: 'wrong_transfer',
        severity: 'high',
        department: 'dispute_resolution',
        review: false,
      },
      {
        message: 'Order failed at merchant but amount deducted from my account',
        caseType: 'payment_failed',
        severity: 'high',
        department: 'payments_ops',
        review: false,
      },
      {
        message: 'Cancel transaction and return my money please',
        caseType: 'refund_request',
        severity: 'low',
        department: 'customer_support',
        review: false,
      },
      {
        message: 'A fake agent sent me a link and asked for my verification code',
        caseType: 'phishing_or_social_engineering',
        severity: 'critical',
        department: 'fraud_risk',
        review: true,
      },
      {
        message: 'I cannot open the app settings page',
        caseType: 'other',
        severity: 'low',
        department: 'customer_support',
        review: false,
      },
    ]

    for (const item of cases) {
      const result = await sort(item.message)

      expect(result.case_type).toBe(item.caseType)
      expect(result.severity).toBe(item.severity)
      expect(result.department).toBe(item.department)
      expect(result.human_review_required).toBe(item.review)
    }
  })

  it('prioritizes phishing over other financial keywords', async () => {
    const result = await sort(
      'Payment failed and someone called asking my OTP to refund the transaction'
    )

    expect(result.case_type).toBe('phishing_or_social_engineering')
    expect(result.severity).toBe('critical')
    expect(result.department).toBe('fraud_risk')
    expect(result.human_review_required).toBe(true)
  })

  it('does not treat harmless credential support wording as phishing by itself', async () => {
    const forgottenPin = await sort('I forgot my PIN and cannot login')
    expect(forgottenPin.case_type).toBe('other')
    expect(forgottenPin.severity).toBe('low')
    expect(forgottenPin.department).toBe('customer_support')
    expect(forgottenPin.human_review_required).toBe(false)

    const otpDelivery = await sort('OTP is not coming when I try to sign in')
    expect(otpDelivery.case_type).toBe('other')
    expect(otpDelivery.severity).toBe('low')
    expect(otpDelivery.human_review_required).toBe(false)
  })

  it('supports Bengali and mixed-language messages', async () => {
    const wrongTransfer = await sort('আমি ভুল নাম্বার এ ১৫০০ টাকা পাঠিয়েছি')
    expect(wrongTransfer.case_type).toBe('wrong_transfer')
    expect(wrongTransfer.severity).toBe('high')

    const payment = await sort('পেমেন্ট ফেল হয়েছে কিন্তু টাকা কেটে নিয়েছে')
    expect(payment.case_type).toBe('payment_failed')
    expect(payment.department).toBe('payments_ops')

    const phishing = await sort('ভুয়া কল করে পিন জানতে চেয়েছে')
    expect(phishing.case_type).toBe('phishing_or_social_engineering')
    expect(phishing.human_review_required).toBe(true)
  })
})

describe('severity and department rules', () => {
  it('maps each case type to the expected default department', () => {
    expect(departmentFor('other', 'low')).toBe('customer_support')
    expect(departmentFor('refund_request', 'low')).toBe('customer_support')
    expect(departmentFor('refund_request', 'medium')).toBe('dispute_resolution')
    expect(departmentFor('wrong_transfer', 'high')).toBe('dispute_resolution')
    expect(departmentFor('payment_failed', 'high')).toBe('payments_ops')
    expect(departmentFor('phishing_or_social_engineering', 'critical')).toBe('fraud_risk')
  })

  it('sets critical only for phishing/social engineering cases', () => {
    expect(determineSeverity('phishing_or_social_engineering', 'otp asked', null)).toBe('critical')
    expect(determineSeverity('wrong_transfer', 'wrong number', 1000)).toBe('high')
    expect(determineSeverity('payment_failed', 'payment failed', 1000)).toBe('high')
    expect(determineSeverity('refund_request', 'refund', null)).toBe('low')
    expect(determineSeverity('other', 'app crashed', null)).toBe('low')
  })

  it('raises high severity for urgent non-phishing tickets', () => {
    expect(determineSeverity('other', 'urgent cannot access account now', null)).toBe('high')
    expect(determineSeverity('refund_request', 'emergency refund needed immediately', null)).toBe(
      'high'
    )
  })

  it('raises contested or high amount refunds to medium', () => {
    expect(determineSeverity('refund_request', 'refund 10000 taka', 10_000)).toBe('medium')
    expect(determineSeverity('refund_request', 'charged twice and want refund', null)).toBe(
      'medium'
    )
    expect(determineSeverity('refund_request', 'refund 999 taka', 999)).toBe('low')
  })
})

describe('summary safety and formatting', () => {
  it('never asks for sensitive credentials in any generated summary', async () => {
    const riskyMessages = [
      'Someone called asking my OTP and PIN',
      'Fake support asked for my password to refund money',
      'Scammer wants my full card number',
      'Payment failed but balance deducted',
      'I sent 3000 to wrong number',
      'Please refund my last transaction',
      'App crashed on login',
    ]

    for (const message of riskyMessages) {
      const result = await sort(message)
      const summary = result.agent_summary.toLocaleLowerCase()

      for (const phrase of sensitiveRequestPhrases) {
        expect(summary.includes(phrase)).toBe(false)
      }
    }
  })

  it('uses neutral one-sentence templates for all case types', () => {
    for (const caseType of caseTypes) {
      const summary = makeSummary(caseType, caseType === 'wrong_transfer' ? 2500 : null)

      expect(summary).toStartWith('Customer ')
      expect(summary.endsWith('.')).toBe(true)
      expect(summary.split(/[.!?]/).filter(Boolean).length).toBe(1)
    }
  })

  it('includes amount only when useful and extracted', async () => {
    const withAmount = await sort('I sent 12,500 taka to wrong number')
    expect(withAmount.agent_summary).toContain('12500 BDT')

    const withoutAmount = await sort('I sent money to wrong number')
    expect(withoutAmount.agent_summary).not.toContain('BDT')
  })
})

describe('pure helper behavior', () => {
  it('normalizes case and whitespace', () => {
    expect(normalize('  Payment   FAILED But Balance Deducted  ')).toBe(
      'payment failed but balance deducted'
    )
  })

  it('extracts the largest four-to-seven digit amount and ignores ticket-like small numbers', () => {
    expect(extractAmount('T-001 sent 500 taka')).toBe(null)
    expect(extractAmount('I sent 1,200 taka then 5000 BDT')).toBe(5000)
    expect(extractAmount('Refund ৳15000 please')).toBe(15000)
  })

  it('keeps confidence within bounds and rounds API output to two decimals', () => {
    const cases = [
      classifyCase('wrong number wrong recipient recover money'),
      classifyCase('payment failed balance deducted order failed charged but merchant did not receive'),
      classifyCase('otp pin password scam fake phishing suspicious'),
      classifyCase('app crashed'),
    ]

    for (const item of cases) {
      expect(item.confidence).toBeGreaterThanOrEqual(0)
      expect(item.confidence).toBeLessThanOrEqual(1)
    }

    expect(sortTicket({ ticket_id: 'T-001', message: 'wrong number wrong recipient' }).confidence)
      .toBe(0.82)
  })

  it('validates request body rules directly', () => {
    expect(validateTicket({ ticket_id: 'T-001', message: 'hello' })).toBe(null)
    expect(validateTicket({ ticket_id: 'T-001', channel: 'sms', locale: 'mixed', message: 'hello' }))
      .toBe(null)
    expect(validateTicket({ ticket_id: '', message: 'hello' })).toContain('ticket_id')
    expect(validateTicket({ ticket_id: 'T-001', message: '' })).toContain('message')
    expect(validateTicket({ ticket_id: 'T-001', channel: 'bad', message: 'hello' })).toContain(
      'channel'
    )
    expect(validateTicket({ ticket_id: 'T-001', locale: 'bad', message: 'hello' })).toContain(
      'locale'
    )
  })
})

describe('throughput sanity', () => {
  it('classifies a batch well under the 30 second endpoint budget', async () => {
    const messages = [
      'I sent 3000 to wrong number',
      'Payment failed but balance deducted',
      'Someone called asking my OTP',
      'Please refund my last transaction',
      'App crashed when I opened it',
    ]

    const startedAt = performance.now()
    for (let index = 0; index < 500; index += 1) {
      const result = sortTicket({
        ticket_id: `T-${index}`,
        message: messages[index % messages.length],
      })
      expect(caseTypes.has(result.case_type)).toBe(true)
    }
    const elapsedMs = performance.now() - startedAt

    expect(elapsedMs).toBeLessThan(1_000)
  })
})
