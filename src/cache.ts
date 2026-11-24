import type { Env, KVLike } from './types'

export interface Cache {
  get<T>(key: string): Promise<T | null>
  put(key: string, value: unknown, ttlSeconds: number): Promise<void>
}

const mem = new Map<string, { v: unknown; exp: number }>()
export const resetMemoryCache = () => mem.clear()

export function memoryCache(): Cache {
  return {
    async get<T>(key: string) {
      const e = mem.get(key)
      if (!e) return null
      if (e.exp < Date.now()) {
        mem.delete(key)
        return null
      }
      return e.v as T
    },
    async put(key, value, ttl) {
      mem.set(key, { v: value, exp: Date.now() + ttl * 1000 })
    },
  }
}

export function kvCache(kv: KVLike): Cache {
  return {
    async get<T>(key: string) {
      return ((await kv.get(key, 'json')) as T | null) ?? null
    },
    async put(key, value, ttl) {
      await kv.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, Math.ceil(ttl)) })
    },
  }
}

export const createCache = (env: Env): Cache => (env.CACHE ? kvCache(env.CACHE) : memoryCache())
