import { Elysia, status } from 'elysia'
import { benchCpu, benchJson, sortTicket, validateTicket } from '../src/index'

type TicketBody = {
  ticket_id?: unknown
  channel?: unknown
  locale?: unknown
  message?: unknown
}

type CpuBody = {
  text?: unknown
  rounds?: unknown
}

const port = Number.parseInt(process.env.PORT ?? '3006', 10)
const maxBodyBytes = 8 * 1024

const app = new Elysia()
  .onRequest(({ request }) => {
    const contentLength = request.headers.get('content-length')
    if (contentLength && Number.parseInt(contentLength, 10) > maxBodyBytes) {
      return status(413, { error: 'Request body is too large.' })
    }
  })
  .onError(({ code, error }) => {
    if (code === 'PARSE') {
      return status(400, { error: 'Request body must be valid JSON.' })
    }

    console.error(error)
    return status(500, { error: 'Internal server error.' })
  })
  .get('/health', () => ({ status: 'ok' }))
  .post('/sort-ticket', ({ body }) => {
    const ticket = body as TicketBody
    const validationError = validateTicket(ticket)

    if (validationError) {
      return status(400, { error: validationError })
    }

    return sortTicket(ticket as { ticket_id: string; message: string })
  })
  .post('/bench/json', ({ body }) => benchJson(body))
  .post('/bench/cpu', ({ body }) => {
    const payload = body as CpuBody
    const text = typeof payload.text === 'string' ? payload.text : ''
    const rounds =
      typeof payload.rounds === 'number' ? Math.max(1, Math.min(10_000, payload.rounds)) : 1_000

    return benchCpu(text, rounds)
  })
  .all('*', () => status(404, { error: 'Not found.' }))
  .listen({
    hostname: '0.0.0.0',
    port,
  })

console.log(`Elysia QueueStorm server listening on http://0.0.0.0:${app.server?.port}`)
