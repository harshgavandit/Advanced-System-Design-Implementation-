import type { IncomingMessage, ServerResponse } from "node:http"
import type { Handler, Next, Query, Request, Response } from "./types.js"

const BODY_LIMIT = 100 * 1024

type Route = {
  method: string
  path: string
  handlers: Handler[]
}

const parseQuery = (url: URL): Query => {
  const query: Query = {}
  for (const [key, value] of url.searchParams) {
    const prev = query[key]
    if (prev === undefined) query[key] = value
    else if (Array.isArray(prev)) prev.push(value)
    else query[key] = [prev, value]
  }
  return query
}

export const decorate = (incoming: IncomingMessage, outgoing: ServerResponse): { req: Request; res: Response } => {
  const url = new URL(incoming.url ?? "/", "http://127.0.0.1")
  const req = incoming as Request
  req.method = incoming.method ?? "GET"
  req.path = url.pathname
  req.originalUrl = incoming.url ?? "/"
  req.query = parseQuery(url)
  req.params = {}
  req.body = undefined
  req.get = (name) => {
    const value = incoming.headers[name.toLowerCase()]
    if (Array.isArray(value)) return value.join(", ")
    return value
  }

  const res = outgoing as Response
  res.status = (code) => {
    res.statusCode = code
    return res
  }
  res.json = (body) => {
    if (res.headersSent) return res
    res.setHeader("Content-Type", "application/json; charset=utf-8")
    res.end(JSON.stringify(body))
    return res
  }
  res.set = (name, value) => {
    res.setHeader(name, value)
    return res
  }

  return { req, res }
}

export const readJsonBody = async (req: Request): Promise<void> => {
  if (req.method === "GET" || req.method === "HEAD") return
  const type = req.headers["content-type"]
  if (typeof type !== "string" || !type.includes("application/json")) return

  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > BODY_LIMIT) {
      throw Object.assign(new Error("Payload too large"), { status: 413 })
    }
    chunks.push(buf)
  }
  if (size === 0) return
  try {
    req.body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 })
  }
}

const matchPath = (pattern: string, pathname: string): Record<string, string> | null => {
  const expected = pattern.split("/").filter(Boolean)
  const actual = pathname.split("/").filter(Boolean)
  if (expected.length !== actual.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < expected.length; i += 1) {
    const token = expected[i]
    if (token.startsWith(":")) params[token.slice(1)] = decodeURIComponent(actual[i])
    else if (token !== actual[i]) return null
  }
  return params
}

export const joinPath = (prefix: string, path: string): string => {
  const left = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix
  if (path === "/") return left || "/"
  return `${left}${path.startsWith("/") ? path : `/${path}`}`
}

export const createRouter = () => {
  const routes: Route[] = []
  let pending: Handler[] = []

  const add = (method: string, path: string, handlers: Handler[]) => {
    routes.push({ method, path, handlers: [...pending, ...handlers] })
  }

  return {
    routes,
    use(handler: Handler) {
      pending = [...pending, handler]
    },
    get(path: string, ...handlers: Handler[]) {
      add("GET", path, handlers)
    },
    post(path: string, ...handlers: Handler[]) {
      add("POST", path, handlers)
    },
    put(path: string, ...handlers: Handler[]) {
      add("PUT", path, handlers)
    },
    patch(path: string, ...handlers: Handler[]) {
      add("PATCH", path, handlers)
    },
    delete(path: string, ...handlers: Handler[]) {
      add("DELETE", path, handlers)
    },
  }
}

export type Router = ReturnType<typeof createRouter>

export const mountRoutes = (prefix: string, router: Router): Route[] =>
  router.routes.map((route) => ({ ...route, path: joinPath(prefix, route.path) }))

export const findRoute = (routes: Route[], method: string, pathname: string) => {
  for (const route of routes) {
    if (route.method !== method) continue
    const params = matchPath(route.path, pathname)
    if (params) return { route, params }
  }
  return null
}

export const runHandlers = (handlers: Handler[], req: Request, res: Response) =>
  new Promise<void>((resolve, reject) => {
    let index = 0
    let settled = false

    const finish = (err?: unknown) => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve()
    }

    const next: Next = (err?: unknown) => {
      if (settled) return
      if (err) {
        finish(err)
        return
      }
      const handler = handlers[index]
      index += 1
      if (!handler) {
        finish()
        return
      }
      let called = false
      const localNext: Next = (error) => {
        if (called) return
        called = true
        next(error)
      }
      try {
        const result = handler(req, res, localNext)
        Promise.resolve(result).then(
          () => {
            if (!called) finish()
          },
          (error) => finish(error),
        )
      } catch (error) {
        finish(error)
      }
    }

    next()
  })
