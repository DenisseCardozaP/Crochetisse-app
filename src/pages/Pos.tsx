import { useCallback, useEffect, useRef, useState } from 'react'
import { liveQuery } from 'dexie'
import { supabase } from '../supabase'
import { money } from '../format'
import { ErrorBox, OkBox } from '../ui'
import {
  backupFile,
  cacheGet,
  cacheSet,
  discardSale,
  localDb,
  purgeOldSynced,
  requestPersistence,
  retryErrors,
  syncOutbox,
} from '../offline'
import type { OutboxSale } from '../offline'
import Sell from './Sell'
import type { EventProduct } from './Sell'

interface OpenEvent {
  id: string
  name: string
  event_date: string
}
interface StatusRow {
  product_id: string
  name: string
  kind: string
  price: number
  qty_brought: number
  qty_remaining: number
}
interface CachedList {
  at: string
  rows: StatusRow[]
}

function useOnline(): boolean {
  const [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return online
}

export default function Pos() {
  const online = useOnline()
  const [events, setEvents] = useState<OpenEvent[]>([])
  const [lists, setLists] = useState<Record<string, CachedList>>({})
  const [outbox, setOutbox] = useState<OutboxSale[]>([])
  const [selected, setSelected] = useState<OpenEvent | null>(null)
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [fromCache, setFromCache] = useState(false)
  const [persisted, setPersisted] = useState<boolean | null>(null)
  const [syncing, setSyncing] = useState(false)
  const busyRef = useRef(false)

  // Datos del bazar: del servidor si hay internet; si no, la última copia guardada
  const refresh = useCallback(async () => {
    try {
      const { data, error } = await supabase.from('events').select('id, name, event_date').eq('status', 'open').order('event_date', { ascending: false })
      if (error) throw new Error(error.message)
      const evs = (data ?? []) as OpenEvent[]
      const next: Record<string, CachedList> = {}
      for (const e of evs) {
        const r = await supabase
          .from('v_event_product_status')
          .select('product_id, name, kind, price, qty_brought, qty_remaining')
          .eq('event_id', e.id)
          .order('name')
        if (r.error) throw new Error(r.error.message)
        next[e.id] = { at: new Date().toISOString(), rows: (r.data ?? []) as StatusRow[] }
        await cacheSet(`ep:${e.id}`, next[e.id])
      }
      await cacheSet('openEvents', evs)
      setEvents(evs)
      setLists(next)
      setFromCache(false)
    } catch {
      const evs = (await cacheGet<OpenEvent[]>('openEvents')) ?? []
      const next: Record<string, CachedList> = {}
      for (const e of evs) {
        const c = await cacheGet<CachedList>(`ep:${e.id}`)
        if (c) next[e.id] = c
      }
      setEvents(evs)
      setLists(next)
      setFromCache(true)
    }
  }, [])

  const sync = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    setSyncing(true)
    const r = await syncOutbox()
    setSyncing(false)
    busyRef.current = false
    setMsg(r.message)
    if (r.sent > 0) refresh()
  }, [refresh])

  useEffect(() => {
    purgeOldSynced()
    requestPersistence().then(setPersisted)
    refresh().then(() => sync())
    const sub = liveQuery(() => localDb.outbox.orderBy('created_at').reverse().toArray()).subscribe({
      next: (rows) => setOutbox(rows),
      error: () => setError('No se pudo leer el almacenamiento local de este dispositivo.'),
    })
    const onOnline = () => {
      refresh().then(() => sync())
    }
    window.addEventListener('online', onOnline)
    const timer = window.setInterval(() => {
      if (navigator.onLine) sync()
    }, 30000)
    return () => {
      sub.unsubscribe()
      window.removeEventListener('online', onOnline)
      window.clearInterval(timer)
    }
  }, [refresh, sync])

  const pending = outbox.filter((s) => s.status === 'pending')
  const errors = outbox.filter((s) => s.status === 'error')
  const synced = outbox.filter((s) => s.status === 'synced')

  // piezas que quedan = lo que dijo el servidor − lo vendido en este dispositivo después de esa copia
  function productsFor(e: OpenEvent): EventProduct[] {
    const c = lists[e.id]
    if (!c) return []
    const used = new Map<string, number>()
    for (const s of outbox) {
      if (s.event_id !== e.id || s.status === 'error' || s.created_at <= c.at) continue
      for (const l of s.lines) {
        if (l.type === 'product') used.set(String(l.product_id), (used.get(String(l.product_id)) ?? 0) + Number(l.qty))
      }
    }
    return c.rows.map((r) => ({
      product_id: r.product_id,
      name: r.name,
      kind: r.kind,
      price: Number(r.price),
      qty_brought: r.qty_brought,
      qty_remaining: r.qty_remaining - (used.get(r.product_id) ?? 0),
    }))
  }

  async function askPersist() {
    const ok = await requestPersistence()
    setPersisted(ok)
    setMsg(ok ? 'Almacenamiento persistente concedido.' : 'No se concedió: instala la app en la pantalla de inicio e inténtalo de nuevo.')
  }

  return (
    <div>
      <div className="section-head">
        <h2>Vender</h2>
        <span className={online ? 'ok-box' : 'error-box'} style={{ margin: 0 }}>
          {online ? 'En línea' : 'Sin conexión: las ventas se guardan en este dispositivo'}
        </span>
      </div>
      <ErrorBox message={error} />
      <OkBox message={msg} />

      <ul className="kv">
        <li>
          <span>Ventas pendientes de enviar</span>
          <b>{pending.length}</b>
        </li>
        {errors.length > 0 && (
          <li>
            <span>Ventas con error (revisa abajo)</span>
            <b>{errors.length}</b>
          </li>
        )}
        <li>
          <span>Almacenamiento seguro en este dispositivo</span>
          <b>{persisted === null ? 'no disponible' : persisted ? 'sí' : 'no concedido'}</b>
        </li>
      </ul>
      <div className="actions left">
        <button className="primary" onClick={sync} disabled={syncing || !online}>
          {syncing ? 'Enviando...' : 'Enviar ahora'}
        </button>
        <button onClick={backupFile}>Respaldo de ventas</button>
        {persisted === false && <button onClick={askPersist}>Pedir almacenamiento seguro</button>}
      </div>

      <h3>Bazares abiertos</h3>
      {fromCache && events.length > 0 && <p className="hint">Mostrando la última copia guardada (sin conexión).</p>}
      {events.length === 0 ? (
        <p className="muted">
          No hay bazares abiertos guardados. Abre esta pantalla con internet una vez (en “Bazares” crea el bazar y su lista) para
          poder vender sin conexión.
        </p>
      ) : (
        <ul className="list">
          {events.map((e) => (
            <li key={e.id}>
              <span>
                <b>{e.name}</b> · {e.event_date}
              </span>
              <button className="primary" onClick={() => setSelected(e)} disabled={!lists[e.id]}>
                Vender
              </button>
            </li>
          ))}
        </ul>
      )}

      {errors.length > 0 && (
        <>
          <h3>Ventas con error</h3>
          <p className="hint">
            El servidor las rechazó (por ejemplo, el bazar ya estaba cerrado). No se descontó inventario. Puedes reintentar o
            descartarlas si ya no aplican.
          </p>
          <ul className="list">
            {errors.map((s) => (
              <li key={s.client_uuid}>
                <span>
                  <b>{money(s.total)}</b> · {s.event_name} · {new Date(s.sold_at).toLocaleString('es-MX')}
                  <br />
                  <span className="muted small">{s.summary}</span>
                  <br />
                  <span className="small" style={{ color: 'var(--bad)' }}>
                    {s.last_error}
                  </span>
                </span>
                <span className="row-actions">
                  <button
                    onClick={async () => {
                      await retryErrors()
                      sync()
                    }}
                  >
                    Reintentar
                  </button>
                  <button
                    onClick={() => {
                      if (window.confirm('¿Descartar esta venta? Se borra de este dispositivo.')) discardSale(s.client_uuid)
                    }}
                  >
                    Descartar
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>Últimas ventas de este dispositivo</h3>
      {outbox.length === 0 ? (
        <p className="muted">Aún no hay ventas.</p>
      ) : (
        <ul className="list compact">
          {outbox.slice(0, 15).map((s) => (
            <li key={s.client_uuid}>
              <span>
                <b>{money(s.total)}</b> · {new Date(s.sold_at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })} ·{' '}
                <span className="muted small">{s.summary}</span>
              </span>
              <span className="pill">{s.status === 'synced' ? 'enviada' : s.status === 'pending' ? 'pendiente' : 'error'}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="hint">
        {synced.length} ventas enviadas se conservan 30 días en este dispositivo como respaldo. Usa “Respaldo de ventas” antes de
        borrar datos del navegador o reinstalar la app.
      </p>

      {selected && (
        <Sell
          eventId={selected.id}
          eventName={selected.name}
          products={productsFor(selected)}
          onSold={() => {
            /* la cola local se actualiza sola */
          }}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}
