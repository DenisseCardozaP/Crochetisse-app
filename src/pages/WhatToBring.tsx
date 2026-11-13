import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { friendlyError, money } from '../format'
import { ErrorBox, OkBox } from '../ui'

export interface Reco {
  product_id: string
  name: string
  tag: 'estrella' | 'constante' | 'lento' | 'sin_ventas' | 'nuevo'
  events_count: number
  qty_brought: number
  qty_sold: number
  sell_through: number | null
  avg_sold: number
  avg_price: number | null
  unit_cost: number | null
  profit_per_unit: number | null
  profit_total: number
  stock_now: number
  suggested_qty: number
  to_produce: number
  last_event: string | null
}

export const TAG_LABEL: Record<string, string> = {
  estrella: 'Estrella',
  constante: 'Constante',
  lento: 'Lento',
  sin_ventas: 'Sin ventas',
  nuevo: 'Nuevo',
}
const TAG_HELP: Record<string, string> = {
  estrella: 'Vendes casi todo lo que llevas: lleva más.',
  constante: 'Se vende bien: lleva un poco más de lo que sueles vender.',
  lento: 'Se vende poco de lo que llevas: lleva solo lo que sueles vender.',
  sin_ventas: 'Lo llevaste y no se vendió: mejor no llevarlo.',
  nuevo: 'Nunca lo has llevado: prueba con pocas piezas.',
}

export function toReco(r: any): Reco {
  const n = (v: any) => (v === null || v === undefined ? null : Number(v))
  return {
    ...r,
    events_count: Number(r.events_count),
    qty_brought: Number(r.qty_brought),
    qty_sold: Number(r.qty_sold),
    sell_through: n(r.sell_through),
    avg_sold: Number(r.avg_sold),
    avg_price: n(r.avg_price),
    unit_cost: n(r.unit_cost),
    profit_per_unit: n(r.profit_per_unit),
    profit_total: Number(r.profit_total),
    stock_now: Number(r.stock_now),
    suggested_qty: Number(r.suggested_qty),
    to_produce: Number(r.to_produce),
  }
}

export default function WhatToBring() {
  const [rows, setRows] = useState<Reco[]>([])
  const [events, setEvents] = useState<{ id: string; name: string; event_date: string }[]>([])
  const [eventId, setEventId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [r, e] = await Promise.all([
      supabase.rpc('bazaar_recommendations'),
      supabase.from('events').select('id, name, event_date').eq('status', 'open').order('event_date', { ascending: false }),
    ])
    if (r.error) {
      setLoading(false)
      return setError(friendlyError(r.error.message))
    }
    setRows((r.data ?? []).map(toReco))
    setEvents(e.data ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Carga las cantidades sugeridas en la lista del bazar elegido (no cambia precios ya puestos)
  async function apply() {
    if (!eventId) return
    setBusy(true)
    setError('')
    setOk('')
    const [cur, ov] = await Promise.all([
      supabase.from('event_products').select('product_id').eq('event_id', eventId),
      supabase.from('v_product_overview').select('id, current_price, suggested_price'),
    ])
    if (cur.error || ov.error) {
      setBusy(false)
      return setError(friendlyError((cur.error ?? ov.error)!.message))
    }
    const inList = new Set((cur.data ?? []).map((x: { product_id: string }) => x.product_id))
    const price = new Map((ov.data ?? []).map((x: any) => [x.id, x.current_price ?? x.suggested_price ?? 0]))
    let n = 0
    for (const r of rows) {
      if (r.suggested_qty <= 0) continue
      if (inList.has(r.product_id)) {
        const { error } = await supabase.from('event_products').update({ qty_brought: r.suggested_qty }).eq('event_id', eventId).eq('product_id', r.product_id)
        if (error) {
          setBusy(false)
          return setError(friendlyError(error.message))
        }
      } else {
        const { error } = await supabase.from('event_products').insert({
          event_id: eventId,
          product_id: r.product_id,
          price: r.avg_price ?? price.get(r.product_id) ?? 0,
          qty_brought: r.suggested_qty,
        })
        if (error) {
          setBusy(false)
          return setError(friendlyError(error.message))
        }
      }
      n++
    }
    setBusy(false)
    setOk(`Listo: ${n} productos cargados a la lista del bazar con las cantidades sugeridas. Puedes ajustarlas en Bazares.`)
  }

  const toMake = rows.filter((r) => r.to_produce > 0)

  return (
    <div>
      <div className="section-head">
        <h2>Qué llevar a un bazar</h2>
      </div>
      <p className="muted small">
        Se calcula con tus bazares anteriores (las ventas anuladas no cuentan) y con lo que tienes terminado hoy. Entre más bazares registres, mejores serán las sugerencias.
      </p>
      <ErrorBox message={error} />
      <OkBox message={ok} />
      {loading ? (
        <p className="muted">Cargando...</p>
      ) : (
        <>
          <div className="panel-card" style={{ marginBottom: 14 }}>
            <h3>Cargar a un bazar</h3>
            <div className="filters">
              <select value={eventId} onChange={(e) => setEventId(e.target.value)}>
                <option value="">Elige un bazar abierto...</option>
                {events.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} · {e.event_date}
                  </option>
                ))}
              </select>
              <button className="primary" disabled={!eventId || busy} onClick={apply}>
                {busy ? 'Cargando...' : 'Usar estas cantidades'}
              </button>
            </div>
            <p className="hint">Los productos que ya estén en la lista conservan su precio; los nuevos entran con su precio promedio de venta.</p>
          </div>

          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Producto</th>
                  <th>Cómo va</th>
                  <th>Bazares</th>
                  <th>Vendido / llevado</th>
                  <th>Ganancia por pieza</th>
                  <th>Tienes</th>
                  <th>Llevar</th>
                  <th>Por tejer</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.product_id}>
                    <td>{r.name}</td>
                    <td>
                      <span className={'tag ' + r.tag} title={TAG_HELP[r.tag]}>
                        {TAG_LABEL[r.tag]}
                      </span>
                    </td>
                    <td>{r.events_count}</td>
                    <td>
                      {r.qty_sold} / {r.qty_brought}
                      {r.sell_through !== null && <span className="muted small"> ({Math.round(r.sell_through * 100)}%)</span>}
                    </td>
                    <td>{r.profit_per_unit === null ? '—' : money(r.profit_per_unit)}</td>
                    <td>{r.stock_now}</td>
                    <td>
                      <b>{r.suggested_qty}</b>
                    </td>
                    <td>{r.to_produce > 0 ? <b style={{ color: 'var(--rose-dark)' }}>{r.to_produce}</b> : '—'}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={8} className="muted">
                      Todavía no hay productos.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {toMake.length > 0 && (
            <p>
              Para llegar a lo sugerido te faltaría tejer: {toMake.map((r) => `${r.to_produce} ${r.name}`).join(', ')}.
            </p>
          )}
          <ul className="muted small" style={{ lineHeight: 1.7 }}>
            {Object.keys(TAG_LABEL).map((k) => (
              <li key={k}>
                <span className={'tag ' + k}>{TAG_LABEL[k]}</span> {TAG_HELP[k]}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
