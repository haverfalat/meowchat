import { hostname, networkInterfaces } from 'node:os'

const TARGET = (process.env.TARGET || 'http://localhost:3000').replace(/\/+$/, '')
const PORT = Number(process.env.PORT) || 80
const HOSTNAME = process.env.MDNS_HOST || 'meowchat.local'
const NO_MDNS = process.env.NO_MDNS === '1'

const bridgeId = `${hostname()}-${PORT}-${crypto.randomUUID().slice(0, 8)}`
const wsTargetBase = TARGET.replace(/^http/, 'ws')
const portSuffix = PORT === 80 ? '' : `:${PORT}`

const getLanIps = () => {
  if (process.env.LAN_IP) return [process.env.LAN_IP]
  const ips = []
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) ips.push(addr.address)
    }
  }
  return ips.length > 0 ? ips : ['127.0.0.1']
}

let mdns = null
let currentPrimaryIp = ''

const syncMdns = () => {
  const ips = getLanIps()
  const primary = ips[0]
  if (primary === currentPrimaryIp) return ips

  currentPrimaryIp = primary
  mdns?.kill()
  mdns =
    !NO_MDNS && process.platform === 'darwin'
      ? Bun.spawn(['dns-sd', '-P', 'meowchat', '_http._tcp', 'local', String(PORT), HOSTNAME, primary], {
          stdout: 'ignore',
          stderr: 'ignore',
        })
      : null
  console.log(`bridging http://${HOSTNAME}${portSuffix} (${ips.join(', ')}) -> ${TARGET}`)
  return ips
}

const reportToServer = async () => {
  const ips = syncMdns()
  const urls = [
    ...(!NO_MDNS ? [`http://${HOSTNAME}${portSuffix}`] : []),
    ...ips.map((ip) => `http://${ip}${portSuffix}`),
  ]
  try {
    await fetch(`${TARGET}/api/bridges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: bridgeId, urls }),
    })
  } catch {
    // Server temporarily unreachable; next heartbeat will retry
  }
}

syncMdns()
reportToServer()
const heartbeat = setInterval(reportToServer, 5000)

const cleanup = async () => {
  clearInterval(heartbeat)
  mdns?.kill()
  try {
    await fetch(`${TARGET}/api/bridges/${bridgeId}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(500),
    })
  } catch {}
  process.exit(0)
}
process.on('SIGINT', cleanup)
process.on('SIGTERM', cleanup)

Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url)

    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const ok = server.upgrade(req, {
        data: {
          path: url.pathname + url.search,
          cookie: req.headers.get('cookie') || '',
        },
      })
      return ok ? undefined : new Response('WebSocket upgrade failed', { status: 400 })
    }

    const headers = new Headers(req.headers)
    headers.delete('host')

    const res = await fetch(`${TARGET}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
      redirect: 'manual',
    })

    return new Response(res.body, {
      status: res.status,
      headers: res.headers,
    })
  },
  websocket: {
    open(ws) {
      const queue = []
      const upstream = new WebSocket(`${wsTargetBase}${ws.data.path}`, {
        headers: ws.data.cookie ? { cookie: ws.data.cookie } : undefined,
      })

      ws.data.upstream = upstream
      ws.data.queue = queue

      upstream.onopen = () => {
        for (const msg of queue) upstream.send(msg)
        queue.length = 0
      }
      upstream.onmessage = (e) => ws.send(e.data)
      upstream.onclose = () => ws.close()
      upstream.onerror = () => ws.close()
    },
    message(ws, msg) {
      const { upstream, queue } = ws.data
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(msg)
      } else if (upstream.readyState === WebSocket.CONNECTING) {
        queue.push(msg)
      }
    },
    close(ws) {
      ws.data.upstream?.close()
    },
  },
})
