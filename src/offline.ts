import Dexie from 'dexie'
import type { Table } from 'dexie'
import { supabase } from './supabase'
import { todayMX } from './format'

// ---------------------------------------------------------------- base local (IndexedDB)
export interface OutboxSale {
  client_uuid: string
  status: 'pending' | 'error' | 'synced'
  created_at: string
  total: number
  event_id: string | null
  event_name: string
  payment_method_id: string
  sale_date: string
  sold_at: string
  note: string | null
  lines: Record<string, unknown>[]
  summary: string
  last_error?: string
  synced_at?: string
}

interface CacheRow {
  key: string
  value: unknown
  saved_at: string
}

class LocalDB extends Dexie {
  outbox!: Table<OutboxSale, string>
  cache!: Table<CacheRow, string>
  constructor() {
    super('amigurumis_app')
    this.version(1).stores({
      outbox: 'client_uuid, status, created_at',
      cache: 'key',
    })
  }
}
export const localDb = new LocalDB()

// ---------------------------------------------------------------- caché de datos de referencia
export async function cacheSet(key: string, value: unknown): Promise<void> {
  try {
    await localDb.cache.put({ key, value, saved_at: new Date().toISOString() })
  } catch {
    /* si falla el almacenamiento local, la app sigue funcionando en línea */
  }
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const row = await localDb.cache.get(key)
    return row ? (row.value as T) : null
  } catch {
    return null
  }
}

// Pide al servidor; si funciona, guarda copia local. Si no hay conexión, usa la última copia.
export async function fetchWithCache<T>(key: string, fetcher: () => Promise<T>): Promise<{ data: T | null; fromCache: boolean }> {
  try {
    const data = await fetcher()
    await cacheSet(key, data)
    return { data, fromCache: false }
  } catch {
    const data = await cacheGet<T>(key)
    return { data, fromCache: true }
  }
}

// ---------------------------------------------------------------- cola de ventas
export async function enqueueSale(s: Omit<OutboxSale, 'status' | 'created_at' | 'sale_date'>): Promise<void> {
  await localDb.outbox.put({
    ...s,
    status: 'pending',
    created_at: new Date().toISOString(),
    sale_date: todayMX(),
  })
}

export interface SyncResult {
  ok: boolean
  message: string
  sent: number
  errors: number
}

let running = false

// Un error del servidor trae código (por ejemplo P0001); un fallo de red no.
function isNetworkError(e: { code?: string; message?: string }): boolean {
  if (!e.code) return true
  if (e.code.startsWith('PGRST3')) return true // sesión vencida
  return /jwt/i.test(e.message ?? '')
}

export async function syncOutbox(): Promise<SyncResult> {
  if (running) return { ok: true, message: 'Ya hay una sincronización en curso', sent: 0, errors: 0 }
  if (!navigator.onLine) return { ok: false, message: 'Sin conexión', sent: 0, errors: 0 }
  running = true
  let sent = 0
  let errors = 0
  try {
    const { data: sess } = await supabase.auth.getSession()
    if (!sess.session) return { ok: false, message: 'Inicia sesión para sincronizar', sent: 0, errors: 0 }
    const pending = await localDb.outbox.where('status').equals('pending').sortBy('created_at')
    for (const s of pending) {
      const { error } = await supabase.rpc('register_sale', {
        p_event_id: s.event_id,
        p_payment_method_id: s.payment_method_id,
        p_lines: s.lines,
        p_note: s.note,
        p_client_uuid: s.client_uuid,
        p_sale_date: s.sale_date,
        p_sold_at: s.sold_at,
      })
      if (!error) {
        await localDb.outbox.update(s.client_uuid, { status: 'synced', synced_at: new Date().toISOString(), last_error: undefined })
        sent++
      } else if (isNetworkError(error)) {
        return { ok: false, message: 'No hay conexión con el servidor; se reintentará.', sent, errors }
      } else {
        await localDb.outbox.update(s.client_uuid, { status: 'error', last_error: error.message })
        errors++
      }
    }
    return {
      ok: errors === 0,
      message: pending.length === 0 ? 'No hay nada pendiente' : `Enviadas ${sent}; con error ${errors}`,
      sent,
      errors,
    }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Error de red', sent, errors }
  } finally {
    running = false
  }
}

export async function retryErrors(): Promise<void> {
  await localDb.outbox.where('status').equals('error').modify({ status: 'pending', last_error: undefined })
}

export async function discardSale(clientUuid: string): Promise<void> {
  await localDb.outbox.delete(clientUuid)
}

// Las ventas ya enviadas se conservan 30 días como respaldo local
export async function purgeOldSynced(): Promise<void> {
  try {
    const limit = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
    const old = await localDb.outbox.where('status').equals('synced').filter((s) => (s.synced_at ?? '') < limit).primaryKeys()
    await localDb.outbox.bulkDelete(old)
  } catch {
    /* sin consecuencias */
  }
}

// ---------------------------------------------------------------- respaldo y almacenamiento
export async function backupFile(): Promise<void> {
  const all = await localDb.outbox.toArray()
  const text = JSON.stringify(all, null, 2)
  const file = new File([text], `respaldo-ventas-${todayMX()}.json`, { type: 'application/json' })
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Respaldo de ventas' })
      return
    }
  } catch {
    /* si cancelas el menú de compartir, intentamos descargar */
  }
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  a.click()
  URL.revokeObjectURL(url)
}

export async function requestPersistence(): Promise<boolean | null> {
  try {
    if (!navigator.storage?.persist) return null
    if (await navigator.storage.persisted()) return true
    return await navigator.storage.persist()
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- datos que necesita la pantalla de venta
export interface RefMethod {
  id: string
  code: string
  name: string
  kind: string
}
export interface RefRate {
  payment_method_id: string
  pct: number
  fixed_fee: number
  vat_on_fee: boolean
}
export interface RefYarn {
  id: string
  name: string
  brand: string | null
  color: string | null
  price_group_id: string | null
}
export interface RefTier {
  group_id: string
  min_qty: number
  unit_price: number
}
export interface RefData {
  methods: RefMethod[]
  rates: RefRate[]
  yarn: RefYarn[]
  tiers: RefTier[]
}

export async function loadRefData(): Promise<{ data: RefData | null; fromCache: boolean }> {
  return fetchWithCache<RefData>('ref', async () => {
    const [m, r, y, t] = await Promise.all([
      supabase.from('payment_methods').select('id, code, name, kind').eq('is_active', true).order('sort_order'),
      supabase.from('v_payment_method_current_rate').select('payment_method_id, pct, fixed_fee, vat_on_fee'),
      supabase.from('items').select('id, name, brand, color, price_group_id').eq('kind', 'resale').eq('is_active', true).order('color'),
      supabase.from('v_group_prices_current').select('group_id, min_qty, unit_price').eq('audience', 'customer'),
    ])
    const err = m.error ?? r.error ?? y.error ?? t.error
    if (err) throw new Error(err.message)
    return {
      methods: (m.data ?? []) as RefMethod[],
      rates: (r.data ?? []) as RefRate[],
      yarn: (y.data ?? []) as RefYarn[],
      tiers: (t.data ?? []) as RefTier[],
    }
  })
}
