export class HttpError extends Error {
  constructor(
    public status: 400 | 404 | 502 | 503,
    message: string,
    public details?: unknown,
  ) {
    super(message)
  }
}

/** fetch JSON dengan timeout. Pesan error sengaja hanya memuat host (tanpa query/API key). */
export async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 8000): Promise<any> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      accept: 'application/json',
      'user-agent': 'metal-price-api/0.1 (+github)',
      ...((init.headers as Record<string, string>) ?? {}),
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`)
  return res.json()
}
