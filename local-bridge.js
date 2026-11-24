import { networkInterfaces } from 'node:os'

const TARGET = (process.env.TARGET || 'http://localhost:3000').replace(/\/+$/, '')
const PORT = Number(process.env.PORT) || 80
const HOSTNAME = process.env.MDNS_HOST || 'meowchat.local'
const NO_MDNS = process.env.NO_MDNS === '1'

const getLanIp = () => {
  if (process.env.LAN_IP) return process.env.LAN_IP
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address
    }
  }
  return '127.0.0.1'
}

const lanIp = getLanIp()
const wsTargetBase = TARGET.replace(/^http/, 'ws')

// Advertise meowchat.local on the Mac's LAN via Bonjour/mDNS
const mdns =
  !NO_MDNS && process.platform === 'darwin'
    ? Bun.spawn(['dns-sd', '-P', 'meowchat', '_http._tcp', 'local', String(PORT), HOSTNAME, lanIp], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
    : null

const cleanup = () => {
  mdns?.kill()
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

console.log(`bridging http://${HOSTNAME}:${PORT} (${lanIp}) -> ${TARGET}`)
