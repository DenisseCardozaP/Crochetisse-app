import { useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { friendlyError, money, todayMX } from '../format'
import { ErrorBox } from '../ui'
import { TAG_LABEL, toReco } from './WhatToBring'
import { lastBackup } from './Backup'
import type { Reco } from './WhatToBring'

interface LowItem {
  id: string
  name: string
  brand: string | null
  color: string | null
  base_unit: string
  min_stock: number
  stock: number
}
interface OrderRow {
  id: string
  order_folio: string | null
  quote_folio: string
  status: string
  customer_name: string
  due_date: string | null
  total: number
  balance: number
}
interface EventRow {
  event_id: string
  name: string
  event_date: string
  status: string
  tickets: number
  gross: number
  profit: number
}
interface Quincena {
  net_sales: number
  utility: number
  withdrawal_due: number
}

const daysFrom = (iso: string, base: string) => Math.round((Date.parse(iso) - Date.parse(base)) / 86400000)
function when(due: string | null, today: string) {
  if (!due) return { text: 'sin fecha', late: false }
  const d = daysFrom(due, today)
  if (d < 0) return { text: `hace ${-d} día${d === -1 ? '' : 's'}`, late: true }
  if (d === 0) return { text: 'hoy', late: false }
  if (d === 1) return { text: 'mañana', late: false }
  return { text: `en ${d} días`, late: false }
}

export default function Dashboard({ isOwner, onGo }: { isOwner: boolean; onGo: (t: any) => void }) {
  const today = todayMX()
  const [low, setLow] = useState<LowItem[]>([])
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [events, setEvents] = useState<EventRow[]>([])
  const [recos, setRecos] = useState<Reco[]>([])
  const [q, setQ] = useState<Quincena | null>(null)
  const [balance, setBalance] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    ;(async () => {
      const [y, m, d] = today.split('-').map(Number)
      const first = d <= 15 ? 1 : 16
      const last = d <= 15 ? 15 : new Date(y, m, 0).getDate()
      const pad = (n: number) => String(n).padStart(2, '0')
      const [items, stock, ord, ev, rec, per, bal] = await Promise.all([
        supabase.from('items').select('id, name, brand, color, base_unit, min_stock').eq('is_active', true).gt('min_stock', 0),
        supabase.from('v_item_stock').select('item_id, stock_qty'),
        supabase
          .from('v_order_summary')
          .select('id, order_folio, quote_folio, status, customer_name, due_date, total, balance')
          .in('status', ['confirmed', 'delivered'])
          .order('due_date', { ascending: true, nullsFirst: false }),
        supabase.from('v_event_summary').select('event_id, name, event_date, status, tickets, gross, profit').order('event_date', { ascending: false }).limit(4),
        supabase.rpc('bazaar_recommendations'),
        isOwner
          ? supabase.rpc('earnings_periods', { p_grain: 'quincena', p_from: `${y}-${pad(m)}-${pad(first)}`, p_to: `${y}-${pad(m)}-${pad(last)}` })
          : Promise.resolve({ data: null, error: null }),
        isOwner ? supabase.rpc('withdrawal_balance', { p_to: today }) : Promise.resolve({ data: null, error: null }),
      ])
      if (!alive) return
      const err = items.error ?? stock.error ?? ord.error ?? ev.error ?? rec.error ?? per.error ?? bal.error
      if (err) setError(friendlyError(err.message))
      const sm = new Map((stock.data ?? []).map((x: any) => [x.item_id, Number(x.stock_qty)]))
      setLow(
        (items.data ?? [])
          .map((i: any) => ({ ...i, min_stock: Number(i.min_stock), stock: sm.get(i.id) ?? 0 }))
          .filter((i: LowItem) => i.stock <= i.min_stock)
          .sort((a: LowItem, b: LowItem) => a.stock / a.min_stock - b.stock / b.min_stock),
      )
      setOrders((ord.data ?? []).map((o: any) => ({ ...o, total: Number(o.total), balance: Number(o.balance) })))
      setEvents((ev.data ?? []).map((e: any) => ({ ...e, tickets: Number(e.tickets), gross: Number(e.gross), profit: Number(e.profit) })))
      setRecos((rec.data ?? []).map(toReco))
      const p0: any = (per.data ?? [])[0]
      setQ(p0 ? { net_sales: Number(p0.net_sales), utility: Number(p0.utility), withdrawal_due: Number(p0.withdrawal_due) } : isOwner ? { net_sales: 0, utility: 0, withdrawal_due: 0 } : null)
      const b0: any = (bal.data ?? [])[0]
      setBalance(b0 ? Number(b0.balance) : null)
      setLoading(false)
    })()
    return () => {
      alive = false
    }
  }, [isOwner, today])

  const lb = lastBackup()
  const backupDays = lb ? Math.round((Date.parse(today) - Date.parse(lb)) / 86400000) : 9999
  const upcoming = orders.filter((o) => o.status === 'confirmed').slice(0, 6)
  const lateCount = orders.filter((o) => o.status === 'confirmed' && o.due_date && o.due_date < today).length
  const toCollect = orders.filter((o) => o.balance > 0)
  const collectTotal = toCollect.reduce((a, o) => a + o.balance, 0)
  const toMake = recos.filter((r) => r.to_produce > 0 && r.tag !== 'nuevo').slice(0, 5)
  const top = recos.filter((r) => r.tag === 'estrella' || r.tag === 'constante').slice(0, 5)
  const name = (i: LowItem) => [i.name, i.brand, i.color].filter(Boolean).join(' · ')
  const label = (o: OrderRow) => `${o.order_folio ?? o.quote_folio} · ${o.customer_name}`

  return (
    <div>
      <div className="hero">
        <div>
          <h1>¡Hola! 🌸</h1>
          <p>Esto es lo que necesita tu atención hoy.</p>
          <span className="date-pill">{new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Mexico_City' })}</span>
        </div>
        <div className="checker two" />
        <div className="checker" />
      </div>
      {isOwner && backupDays !== null && backupDays > 7 && (
        <div className="alert-banner">
          {lastBackup() ? `Hace ${backupDays} días que no respaldas tu información.` : 'Todavía no has descargado un respaldo.'}{' '}
          <button className="linkish" onClick={() => onGo('backup')}>
            Descargar respaldo
          </button>
        </div>
      )}
      <ErrorBox message={error} />
      {loading ? (
        <p className="muted">Cargando...</p>
      ) : (
        <>
          <div className="stat-grid">
            {isOwner && q && (
              <>
                <div className="stat">
                  <div className="k">Ventas netas · quincena</div>
                  <div className="n">{money(q.net_sales)}</div>
                  <div className="s">Solo lo concretado</div>
                </div>
                <div className="stat">
                  <div className="k">Utilidad del negocio</div>
                  <div className="n">{money(q.utility)}</div>
                  <div className="s">Después de tu sueldo</div>
                </div>
                <div className="stat">
                  <div className="k">Pendiente por retirar</div>
                  <div className="n">{money(balance ?? 0)}</div>
                  <div className="s">Tu nómina acumulada</div>
                </div>
              </>
            )}
            <div className="stat">
              <div className="k">Pedidos por entregar</div>
              <div className="n">{orders.filter((o) => o.status === 'confirmed').length}</div>
              <div className="s" style={lateCount ? { fontWeight: 700 } : undefined}>
                {lateCount ? `${lateCount} con fecha vencida` : 'Ninguno vencido'}
              </div>
            </div>
            <div className="stat">
              <div className="k">Por cobrar</div>
              <div className="n">{money(collectTotal)}</div>
              <div className="s">{toCollect.length} pedido(s) con saldo</div>
            </div>
            <div className="stat">
              <div className="k">Insumos con poca existencia</div>
              <div className="n">{low.length}</div>
              <div className="s">Según el mínimo de cada insumo</div>
            </div>
          </div>

          <div className="cards2">
            <div className="panel-card">
              <h3>Entregas próximas</h3>
              <ul className="rows">
                {upcoming.map((o) => {
                  const w = when(o.due_date, today)
                  return (
                    <li key={o.id}>
                      <span>
                        {label(o)} <span className="muted small">· saldo {money(o.balance)}</span>
                      </span>
                      <span className={w.late ? 'when late' : 'when'}>{w.text}</span>
                    </li>
                  )
                })}
              </ul>
              {upcoming.length === 0 && <div className="empty">No tienes pedidos confirmados pendientes.</div>}
              <button className="linkish" onClick={() => onGo('orders')}>
                Ir a pedidos
              </button>
            </div>

            <div className="panel-card">
              <h3>Cobros pendientes</h3>
              <ul className="rows">
                {toCollect.slice(0, 6).map((o) => (
                  <li key={o.id}>
                    <span>
                      {label(o)} <span className="muted small">· {o.status === 'delivered' ? 'ya entregado' : 'por entregar'}</span>
                    </span>
                    <b>{money(o.balance)}</b>
                  </li>
                ))}
              </ul>
              {toCollect.length === 0 && <div className="empty">Nada por cobrar. 🎉</div>}
            </div>

            <div className="panel-card">
              <h3>Poca existencia</h3>
              <ul className="rows">
                {low.slice(0, 8).map((i) => (
                  <li key={i.id}>
                    <span>{name(i)}</span>
                    <span className={i.stock <= 0 ? 'when late' : 'when'}>
                      {i.stock} / mín. {i.min_stock} {i.base_unit}
                    </span>
                  </li>
                ))}
              </ul>
              {low.length === 0 && <div className="empty">Todo está por encima del mínimo. Define el mínimo de cada insumo para recibir avisos.</div>}
              <button className="linkish" onClick={() => onGo('inventory')}>
                Ir a inventario
              </button>
            </div>

            <div className="panel-card">
              <h3>Últimos bazares</h3>
              <ul className="rows">
                {events.map((e) => (
                  <li key={e.event_id}>
                    <span>
                      {e.name} <span className="muted small">· {e.event_date} · {e.tickets} ventas</span>
                    </span>
                    <span>
                      <b>{money(e.gross)}</b> <span className="muted small">(ganancia {money(e.profit)})</span>
                    </span>
                  </li>
                ))}
              </ul>
              {events.length === 0 && <div className="empty">Aún no has registrado bazares.</div>}
            </div>

            <div className="panel-card">
              <h3>Para tu próximo bazar</h3>
              <ul className="rows">
                {top.map((r) => (
                  <li key={r.product_id}>
                    <span>
                      {r.name} <span className={'tag ' + r.tag}>{TAG_LABEL[r.tag]}</span>
                    </span>
                    <span>
                      llevar <b>{r.suggested_qty}</b>
                    </span>
                  </li>
                ))}
              </ul>
              {top.length === 0 && <div className="empty">Cuando tengas ventas en bazares, aquí verás qué conviene llevar.</div>}
              {toMake.length > 0 && (
                <p className="small" style={{ marginBottom: 4 }}>
                  Por tejer: {toMake.map((r) => `${r.to_produce} ${r.name}`).join(', ')}.
                </p>
              )}
              <button className="linkish" onClick={() => onGo('bring')}>
                Ver todas las sugerencias
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
