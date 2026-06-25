import express from 'express'

const app = express()
const port = Number.parseInt(process.env.PORT ?? '3005', 10)

app.use(express.json({ limit: '8kb' }))

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

app.post('/sort-ticket', (req, res) => {
  const error = validateTicket(req.body)
  if (error) {
    res.status(400).json({ error })
    return
  }

  res.json(sortTicket(req.body.ticket_id, req.body.message))
})

app.post('/bench/json', (req, res) => {
  res.json(benchJson(req.body))
})

app.post('/bench/cpu', (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text : ''
  const rounds =
    typeof req.body?.rounds === 'number' ? Math.max(1, Math.min(10000, req.body.rounds)) : 1000

  res.json(benchCpu(text, rounds))
})

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found.' })
})

app.use((error, _req, res, _next) => {
  if (error?.type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body is too large.' })
    return
  }

  res.status(400).json({ error: 'Request body must be valid JSON.' })
})

app.listen(port, '0.0.0.0', () => {
  console.log(`Express QueueStorm server listening on http://0.0.0.0:${port}`)
})

function validateTicket(body) {
  if (typeof body?.ticket_id !== 'string' || body.ticket_id.trim() === '') {
    return 'ticket_id is required and must be a non-empty string.'
  }
  if (typeof body?.message !== 'string' || body.message.trim() === '') {
    return 'message is required and must be a non-empty string.'
  }
  if (
    body.channel !== undefined &&
    !['app', 'sms', 'call_center', 'merchant_portal'].includes(body.channel)
  ) {
    return 'channel must be one of: app, sms, call_center, merchant_portal.'
  }
  if (body.locale !== undefined && !['bn', 'en', 'mixed'].includes(body.locale)) {
    return 'locale must be one of: bn, en, mixed.'
  }
  return null
}

function sortTicket(ticketId, rawMessage) {
  const message = normalize(rawMessage)
  const amount = extractAmount(message)
  const { caseType, confidence } = classifyCase(message)
  const severity = determineSeverity(caseType, message, amount)

  return {
    ticket_id: ticketId,
    case_type: caseType,
    severity,
    department: departmentFor(caseType, severity),
    agent_summary: makeSummary(caseType, amount),
    human_review_required: caseType === 'phishing_or_social_engineering' || severity === 'critical',
    confidence: Math.round(confidence * 100) / 100,
  }
}

function benchJson(body) {
  const items = Array.isArray(body?.items) ? body.items : []
  let activeCount = 0
  let amountTotal = 0
  let labelChecksum = 2166136261

  for (const item of items) {
    if (item?.active === true) activeCount += 1
    if (typeof item?.amount === 'number' && Number.isFinite(item.amount)) {
      amountTotal += item.amount
    }
    if (typeof item?.label === 'string') {
      labelChecksum = checksum(item.label, 1, labelChecksum)
    }
  }

  return {
    item_count: items.length,
    active_count: activeCount,
    amount_total: Math.round(amountTotal * 100) / 100,
    label_checksum: labelChecksum >>> 0,
  }
}

function benchCpu(text, rounds) {
  return { bytes: text.length, rounds, checksum: checksum(text, rounds, 2166136261) }
}

function normalize(text) {
  return text.toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

function classifyCase(message) {
  const scores = Object.fromEntries(
    Object.entries(keywords).map(([caseType, words]) => [caseType, score(message, words)])
  )
  let phishingScore = scores.phishing_or_social_engineering
  const credentialScore = score(message, credentialWords)

  if (credentialScore > 0 && credentialRiskContextWords.some((word) => message.includes(word))) {
    phishingScore += credentialScore
  }

  if (phishingScore > 0) {
    return {
      caseType: 'phishing_or_social_engineering',
      confidence: Math.min(0.98, 0.78 + phishingScore * 0.05),
    }
  }

  const [bestCase, bestScore] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0]
  if (bestScore === 0) return { caseType: 'other', confidence: 0.55 }

  return { caseType: bestCase, confidence: Math.min(0.95, 0.68 + bestScore * 0.07) }
}

function determineSeverity(caseType, message, amount) {
  if (caseType === 'phishing_or_social_engineering') return 'critical'
  if (urgentWords.some((word) => message.includes(word))) return 'high'
  if (caseType === 'wrong_transfer' || caseType === 'payment_failed') return 'high'
  if (caseType === 'refund_request') {
    if (amount !== null && amount >= 10000) return 'medium'
    return contestedRefundWords.some((word) => message.includes(word)) ? 'medium' : 'low'
  }
  return 'low'
}

function departmentFor(caseType, severity) {
  if (caseType === 'phishing_or_social_engineering') return 'fraud_risk'
  if (caseType === 'payment_failed') return 'payments_ops'
  if (caseType === 'wrong_transfer') return 'dispute_resolution'
  if (caseType === 'refund_request' && severity !== 'low') return 'dispute_resolution'
  return 'customer_support'
}

function makeSummary(caseType, amount) {
  if (caseType === 'wrong_transfer') {
    const amountText = amount !== null ? ` ${amount} BDT` : ''
    return `Customer reports sending${amountText} to the wrong recipient and requests recovery assistance.`
  }
  if (caseType === 'payment_failed') {
    return 'Customer reports a failed payment or transaction where balance may have been deducted.'
  }
  if (caseType === 'refund_request') {
    return 'Customer requests a refund or reversal for a previous transaction.'
  }
  if (caseType === 'phishing_or_social_engineering') {
    return 'Customer reports a suspicious contact or possible credential-targeting attempt that needs fraud review.'
  }
  return 'Customer reports a general issue that does not match payment, refund, transfer, or fraud categories.'
}

function extractAmount(message) {
  const matches = [...message.replace(/,/g, '').matchAll(/(?:৳|tk|taka|bdt)?\s*(\d{4,7})(?:\s*(?:tk|taka|bdt|টাকা))?/gi)]
  const amounts = matches.map((match) => Number.parseInt(match[1], 10)).filter(Number.isFinite)
  return amounts.length > 0 ? Math.max(...amounts) : null
}

function score(message, words) {
  return words.filter((word) => message.includes(word)).length
}

function checksum(text, rounds, seed) {
  let hash = seed >>> 0
  for (let round = 0; round < rounds; round += 1) {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 16777619) >>> 0
    }
    hash ^= round
  }
  return hash >>> 0
}

const keywords = {
  phishing_or_social_engineering: ['scam', 'scammer', 'fraud', 'fake', 'phishing', 'suspicious', 'called me', 'someone called', 'phone call', 'unknown number', 'sms', 'message from', 'sent me a link', 'asking my', 'asked for', 'asks for', 'asking for', 'wants my', 'account locked', 'পুরস্কার', 'প্রতারক', 'ভুয়া'],
  wrong_transfer: ['wrong number', 'wrong recipient', 'wrong account', 'wrong person', 'mistakenly sent', 'mistake transfer', 'sent by mistake', 'sent money to wrong', 'accidental transfer', 'recover money', 'get it back', 'ভুল নাম্বার', 'ভুল নম্বর', 'ভুলে পাঠিয়েছি', 'ভুলে টাকা', 'ফিরত চাই'],
  payment_failed: ['payment failed', 'transaction failed', 'failed payment', 'balance deducted', 'money deducted', 'amount deducted', 'charged but', 'debited', 'merchant did not receive', 'order failed', 'cashout failed', 'send money failed', 'failed but', 'পেমেন্ট ফেল', 'লেনদেন ব্যর্থ', 'টাকা কেটে', 'ব্যালেন্স কেটে'],
  refund_request: ['refund', 'return my money', 'money back', 'cancel transaction', 'changed my mind', 'reverse transaction', 'reversal', 'ফেরত', 'রিফান্ড', 'টাকা ফেরত', 'বাতিল'],
}

const urgentWords = ['urgent', 'immediately', 'emergency', 'account hacked', 'lost all', 'cannot access', 'unauthorized', 'now', 'জরুরি', 'হ্যাক']
const contestedRefundWords = ['dispute', 'unauthorized', 'charged twice', 'double charged']
const credentialWords = ['otp', 'pin', 'password', 'passcode', 'verification code', 'security code', 'cvv', 'card number', 'ওটিপি', 'পিন', 'পাসওয়ার্ড']
const credentialRiskContextWords = ['ask', 'asked', 'asking', 'asks', 'want', 'wants', 'wanted', 'called', 'call', 'sms', 'link', 'fake', 'scam', 'scammer', 'fraud', 'phishing', 'suspicious', 'ভুয়া', 'প্রতারক', 'জানতে', 'চেয়েছে']
