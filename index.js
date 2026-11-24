import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Elysia, t } from 'elysia'

const DB_PATH = process.env.DB_PATH || join(process.cwd(), 'data', 'db.json')
const UPLOADS_DIR = process.env.UPLOADS_DIR || join(dirname(DB_PATH), 'uploads')
const ADMINS_PATH = process.env.ADMINS_PATH || join(process.cwd(), 'admins.json')
const PORT = Number(process.env.PORT) || 3000
const INVITE_CODE = process.env.INVITE_CODE || 'fieldg'
const COOKIE = 'meow_session'
const BUILD_ID = crypto.randomUUID()

const db = (() => {
  try {
    if (!existsSync(DB_PATH)) {
      mkdirSync(join(process.cwd(), 'data'), { recursive: true })
      const init = { users: [], sessions: [], messages: [] }
      writeFileSync(DB_PATH, JSON.stringify(init, null, 2))
      return init
    }
    const parsed = JSON.parse(readFileSync(DB_PATH, 'utf-8'))
    return {
      users: parsed.users || [],
      sessions: parsed.sessions || [],
      messages: parsed.messages || [],
    }
  } catch {
    return { users: [], sessions: [], messages: [] }
  }
})()

const saveDb = () => {
  mkdirSync(dirname(DB_PATH), { recursive: true })
  const tmp = `${DB_PATH}.tmp`
  writeFileSync(tmp, JSON.stringify(db, null, 2))
  renameSync(tmp, DB_PATH)
}

const getUserFromToken = (token) =>
  db.sessions.find((s) => s.token === token)?.username ?? null

const isAdmin = (username) => {
  if (!username) return false
  try {
    if (!existsSync(ADMINS_PATH)) {
      writeFileSync(ADMINS_PATH, '[]\n')
      return false
    }
    const list = JSON.parse(readFileSync(ADMINS_PATH, 'utf-8'))
    return Array.isArray(list) && list.some((u) => String(u).toLowerCase() === username.toLowerCase())
  } catch {
    return false
  }
}

const parseCookie = (header, name) => {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
}

const sockets = new Map() // ws.id -> username
const typing = new Map()  // username -> timeout
const bridges = new Map() // bridgeId -> { urls, lastSeen }

const onlineList = () => [...new Set(sockets.values())].sort()
const typingList = () => [...typing.keys()].sort()

const getLocalUrls = () => {
  const portSuffix = PORT === 80 ? '' : `:${PORT}`
  const urls = []
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        urls.push(`http://${addr.address}${portSuffix}`)
      }
    }
  }
  return urls
}

const getAccessibleUrls = () => {
  const now = Date.now()
  for (const [id, b] of bridges) {
    if (now - b.lastSeen > 20000) bridges.delete(id)
  }
  const all = new Set(getLocalUrls())
  for (const b of bridges.values()) {
    for (const u of b.urls) all.add(u)
  }
  return [...all]
}

let lastUrlsKey = ''
const syncAddresses = (server) => {
  const urls = getAccessibleUrls()
  const key = urls.join('|')
  if (key !== lastUrlsKey) {
    lastUrlsKey = key
    broadcast(server, { type: 'addresses', urls })
  }
}

const broadcast = (server, payload) =>
  server?.publish('chat', JSON.stringify(payload))

const clearTyping = (server, username) => {
  const timer = typing.get(username)
  if (!timer) return
  clearTimeout(timer)
  typing.delete(username)
  broadcast(server, { type: 'typing', typing: typingList() })
}

const app = new Elysia()
  .get('/', ({ cookie, set }) => {
    if (!getUserFromToken(cookie[COOKIE]?.value)) {
      set.status = 302
      set.headers.location = '/login'
      return ''
    }
    return Bun.file('public/chat.html')
  })
  .get('/login', ({ cookie, set }) => {
    if (getUserFromToken(cookie[COOKIE]?.value)) {
      set.status = 302
      set.headers.location = '/'
      return ''
    }
    return Bun.file('public/login.html')
  })
  .post(
    '/api/register',
    async ({ body, cookie, set }) => {
      if (body.invite.trim() !== INVITE_CODE) {
        set.status = 403
        return { ok: false, error: 'Invalid invite code.' }
      }
      const username = body.username.trim()
      if (!/^[a-zA-Z0-9_-]{1,24}$/.test(username)) {
        set.status = 400
        return { ok: false, error: 'Username must be 1-24 chars (a-z, 0-9, _ or -).' }
      }
      if (!body.password) {
        set.status = 400
        return { ok: false, error: 'Password is required.' }
      }
      if (db.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
        set.status = 400
        return { ok: false, error: 'Username already taken.' }
      }

      db.users.push({
        username,
        passwordHash: await Bun.password.hash(body.password),
        createdAt: Date.now(),
      })
      const token = crypto.randomUUID()
      db.sessions.push({ token, username, createdAt: Date.now() })
      saveDb()

      cookie[COOKIE]?.set({
        value: token,
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 24 * 30,
      })
      return { ok: true, username }
    },
    { body: t.Object({ username: t.String(), password: t.String(), invite: t.String() }) },
  )
  .post(
    '/api/login',
    async ({ body, cookie, set }) => {
      const clean = body.username.trim().toLowerCase()
      const user = db.users.find((u) => u.username.toLowerCase() === clean)
      if (!user || !(await Bun.password.verify(body.password, user.passwordHash))) {
        set.status = 401
        return { ok: false, error: 'Invalid username or password.' }
      }

      const token = crypto.randomUUID()
      db.sessions.push({ token, username: user.username, createdAt: Date.now() })
      saveDb()

      cookie[COOKIE]?.set({
        value: token,
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 24 * 30,
      })
      return { ok: true, username: user.username }
    },
    { body: t.Object({ username: t.String(), password: t.String() }) },
  )
  .post('/api/logout', ({ cookie }) => {
    const token = cookie[COOKIE]?.value
    if (token) {
      db.sessions = db.sessions.filter((s) => s.token !== token)
      saveDb()
    }
    cookie[COOKIE]?.remove()
    return { ok: true }
  })
  .get('/api/me', ({ cookie, set }) => {
    const username = getUserFromToken(cookie[COOKIE]?.value)
    if (!username) {
      set.status = 401
      return { ok: false }
    }
    return { ok: true, username }
  })
  .post('/api/upload', async ({ request, cookie, set }) => {
    const username = getUserFromToken(cookie[COOKIE]?.value)
    if (!username) {
      set.status = 401
      return { ok: false, error: 'Unauthorized' }
    }

    const form = await request.formData()
    const rawFiles = [...form.getAll('files'), ...form.getAll('file')].filter(
      (f) => f && typeof f === 'object' && 'size' in f && f.size >= 0,
    )
    if (rawFiles.length === 0) {
      set.status = 400
      return { ok: false, error: 'No files provided.' }
    }
    if (rawFiles.length > 10) {
      set.status = 400
      return { ok: false, error: 'Max 10 files per message.' }
    }

    const files = []
    for (const file of rawFiles) {
      if (file.size > 100 * 1024 * 1024) {
        set.status = 400
        return { ok: false, error: `File ${file.name} exceeds 100 MB limit.` }
      }
      const id = crypto.randomUUID().slice(0, 12)
      const safeName = basename(file.name || 'file').replace(/[^\w.\-() ]+/g, '_') || 'file'
      const dir = join(UPLOADS_DIR, id)
      mkdirSync(dir, { recursive: true })
      await Bun.write(join(dir, safeName), file)
      files.push({
        id,
        name: safeName,
        size: file.size,
        url: `/uploads/${id}/${encodeURIComponent(safeName)}`,
      })
    }

    const caption = form.get('caption')
    const replyToId = form.get('replyToId')
    const replyTarget =
      typeof replyToId === 'string' ? db.messages.find((m) => m.id === replyToId) : null
    const replyTo = replyTarget
      ? {
          id: replyTarget.id,
          username: replyTarget.username,
          text:
            replyTarget.text ||
            (replyTarget.files?.map((f) => f.name).join(', ') || replyTarget.file?.name || 'file'),
        }
      : undefined

    const msg = {
      id: crypto.randomUUID(),
      username,
      text: typeof caption === 'string' ? caption.trim().slice(0, 2000) : '',
      files,
      ...(replyTo ? { replyTo } : {}),
      createdAt: Date.now(),
      seenBy: [username],
    }
    db.messages.push(msg)
    if (db.messages.length > 500) db.messages = db.messages.slice(-500)
    saveDb()

    clearTyping(app.server, username)
    broadcast(app.server, { type: 'message', message: msg })
    return { ok: true, message: msg }
  })
  .get('/uploads/:id/:name', ({ params, set }) => {
    const id = basename(params.id)
    const name = basename(decodeURIComponent(params.name))
    const filePath = join(UPLOADS_DIR, id, name)
    if (!existsSync(filePath)) {
      set.status = 404
      return 'Not found'
    }
    return Bun.file(filePath)
  })
  .post(
    '/api/bridges',
    ({ body }) => {
      bridges.set(body.id, { urls: body.urls.slice(0, 16), lastSeen: Date.now() })
      syncAddresses(app.server)
      return { ok: true }
    },
    { body: t.Object({ id: t.String(), urls: t.Array(t.String()) }) },
  )
  .delete('/api/bridges/:id', ({ params }) => {
    if (bridges.delete(params.id)) {
      syncAddresses(app.server)
    }
    return { ok: true }
  })
  .ws('/ws', {
    open(ws) {
      const token =
        ws.data.cookie?.[COOKIE]?.value ??
        parseCookie(ws.data.headers?.cookie, COOKIE)
      const username = getUserFromToken(token)

      if (!username) {
        ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }))
        return ws.close()
      }

      sockets.set(ws.id, username)
      ws.subscribe('chat')

      ws.send(
        JSON.stringify({
          type: 'init',
          version: BUILD_ID,
          username,
          isAdmin: isAdmin(username),
          messages: db.messages.slice(-100),
          online: onlineList(),
          typing: typingList(),
          addresses: getAccessibleUrls(),
        }),
      )
      broadcast(app.server, { type: 'presence', online: onlineList() })
    },
    message(ws, raw) {
      const username = sockets.get(ws.id)
      if (!username) return

      let data
      try {
        data = typeof raw === 'string' ? JSON.parse(raw) : raw
      } catch {
        return
      }

      if (data.type === 'chat' && typeof data.text === 'string') {
        const text = data.text.trim().slice(0, 2000)
        if (!text) return

        const replyTarget =
          typeof data.replyToId === 'string'
            ? db.messages.find((m) => m.id === data.replyToId)
            : null
        const replyTo = replyTarget
          ? {
              id: replyTarget.id,
              username: replyTarget.username,
              text:
                replyTarget.text ||
                (replyTarget.files?.map((f) => f.name).join(', ') || replyTarget.file?.name || 'file'),
            }
          : undefined

        const msg = {
          id: crypto.randomUUID(),
          username,
          text,
          ...(replyTo ? { replyTo } : {}),
          createdAt: Date.now(),
          seenBy: [username],
        }
        db.messages.push(msg)
        if (db.messages.length > 500) db.messages = db.messages.slice(-500)
        saveDb()

        clearTyping(app.server, username)
        broadcast(app.server, { type: 'message', message: msg })
      } else if (data.type === 'typing') {
        const prev = typing.get(username)
        if (prev) clearTimeout(prev)

        if (data.isTyping) {
          typing.set(
            username,
            setTimeout(() => clearTyping(app.server, username), 3500),
          )
        } else {
          typing.delete(username)
        }
        broadcast(app.server, { type: 'typing', typing: typingList() })
      } else if (data.type === 'seen' && Array.isArray(data.messageIds)) {
        const ids = new Set(data.messageIds.filter((id) => typeof id === 'string'))
        const updates = []
        for (const msg of db.messages) {
          if (ids.has(msg.id) && !msg.seenBy.includes(username)) {
            msg.seenBy.push(username)
            updates.push({ id: msg.id, seenBy: [...msg.seenBy] })
          }
        }
        if (updates.length > 0) {
          saveDb()
          broadcast(app.server, { type: 'seen', updates })
        }
      } else if (data.type === 'delete' && typeof data.id === 'string') {
        if (!isAdmin(username)) return
        const target = db.messages.find((m) => m.id === data.id)
        if (target) {
          db.messages = db.messages.filter((m) => m.id !== data.id)
          const toDelete = [...(target.files || []), ...(target.file ? [target.file] : [])]
          for (const f of toDelete) {
            if (f?.id) rmSync(join(UPLOADS_DIR, basename(f.id)), { recursive: true, force: true })
          }
          saveDb()
          broadcast(app.server, { type: 'delete', id: data.id })
        }
      } else if (data.type === 'clear') {
        if (!isAdmin(username)) return
        db.messages = []
        rmSync(UPLOADS_DIR, { recursive: true, force: true })
        saveDb()
        broadcast(app.server, { type: 'clear' })
      }
    },
    close(ws) {
      const username = sockets.get(ws.id)
      if (!username) return
      sockets.delete(ws.id)
      if (![...sockets.values()].includes(username)) {
        clearTyping(app.server, username)
      }
      broadcast(app.server, { type: 'presence', online: onlineList() })
    },
  })
  .listen(PORT)

setInterval(() => syncAddresses(app.server), 5000)

console.log(`meowchat running at http://localhost:${app.server?.port}`)
