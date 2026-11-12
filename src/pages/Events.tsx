import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { supabase } from '../supabase'
import { friendlyError, isNonNegativeNumber, money, todayMX } from '../format'
import { ErrorBox, Field, Modal, OkBox } from '../ui'
import Sell from './Sell'
import type { EventProduct } from './Sell'

interface Summary {
  event_id: string
  name: string
  event_date: string
  status: 'open' | 'closed'
  table_cost: number
  float_cash: number
  tickets: number
  gross: number
  card_fees: number
  net_after_fees: number
  cost_of_goods: number
  labor_in_cost: number
  profit_before_table: number
  profit: number
  cash_sales: number
  card_sales: number
  other_sales: number
  expected_cash: number
}
interface StatusRow {
  product_id: string
  name: string
  kind: string
  price: number
  qty_brought: number
  qty_sold: number
  qty_remaining: number
  revenue: number
}
interface ProductOpt {
  id: string
  name: string
  kind: string
  is_active: boolean
  current_price: number | null
  suggested_price: number | null
  has_recipe: boolean | null
}
interface SaleRow {
  id: string
  sold_at: string
  total: number
  card_fee: number
  note: string | null
  payment_method_id: string
}
interface SaleLine {
  sale_id: string
  description: string
  qty: number
  unit_price: number
  line_type: string
  delivered: boolean
}

function EventForm(props: { event: Summary | null; onSaved: () => void; onClose: () => void }) {
  const e0 = props.event
  const [name, setName] = useState(e0?.name ?? '')
  const [date, setDate] = useState(e0?.event_date ?? todayMX())
  const [table, setTable] = useState(e0 ? String(e0.table_cost) : '0')
  const [cash, setCash] = useState(e0 ? String(e0.float_cash) : '0')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(ev: FormEvent) {
    ev.preventDefault()
    if (!name.trim()) return setError('Escribe el nombre del bazar.')
    if (!isNonNegativeNumber(table) || !isNonNegativeNumber(cash)) return setError('El costo de la mesa y el fondo deben ser números.')
    setBusy(true)
    const row = { name: name.trim(), event_date: date, table_cost: table, float_cash: cash }
    const res = e0 ? await supabase.from('events').update(row).eq('id', e0.event_id) : await supabase.from('events').insert(row)
    setBusy(false)
    if (res.error) return setError(friendlyError(res.error.message))
    props.onSaved()
  }

  return (
    <Modal title={e0 ? 'Editar bazar' : 'Nuevo bazar'} onClose={props.onClose}>
      <form onSubmit={submit}>
        <Field label="Nombre">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid3">
          <Field label="Fecha">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Costo de la mesa">
            <input inputMode="decimal" value={table} onChange={(e) => setTable(e.target.value)} />
          </Field>
          <Field label="Fondo de caja (cambio)">
            <input inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} />
          </Field>
        </div>
        <ErrorBox message={error} />
        <div className="actions">
          <button type="button" onClick={props.onClose}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Guardando...' : 'Guardar'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function EventDetail(props: { summary: Summary; others: Summary[]; onChanged: () => void; onClose: () => void }) {
  const ev = props.summary
  const [list, setList] = useState<StatusRow[]>([])
  const [opts, setOpts] = useState<ProductOpt[]>([])
  const [sales, setSales] = useState<SaleRow[]>([])
  const [lines, setLines] = useState<SaleLine[]>([])
  const [voided, setVoided] = useState<Set<string>>(new Set())
  const [methods, setMethods] = useState<Map<string, string>>(new Map())
  const [addId, setAddId] = useState('')
  const [copyFrom, setCopyFrom] = useState('')
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')
  const [selling, setSelling] = useState(false)
  const [editing, setEditing] = useState(false)
  const open = ev.status === 'open'

  const load = useCallback(async () => {
    setError('')
    const [l, o, s, v, m] = await Promise.all([
      supabase.from('v_event_product_status').select('*').eq('event_id', ev.event_id).order('name'),
      supabase.from('v_product_overview').select('id, name, kind, is_active, current_price, suggested_price, has_recipe').order('name'),
      supabase.from('sales').select('id, sold_at, total, card_fee, note, payment_method_id').eq('event_id', ev.event_id).order('sold_at', { ascending: false }),
      supabase.from('sale_voids').select('sale_id'),
      supabase.from('payment_methods').select('id, name'),
    ])
    if (l.error) setError(friendlyError(l.error.message))
    else setList((l.data ?? []) as StatusRow[])
    if (!o.error) setOpts((o.data ?? []) as ProductOpt[])
    if (s.error) setError(friendlyError(s.error.message))
    else {
      const rows = (s.data ?? []) as SaleRow[]
      setSales(rows)
      if (rows.length > 0) {
        const ln = await supabase
          .from('sale_lines')
          .select('sale_id, description, qty, unit_price, line_type, delivered')
          .in('sale_id', rows.map((r) => r.id))
        if (!ln.error) setLines((ln.data ?? []) as SaleLine[])
      } else setLines([])
    }
    if (!v.error) setVoided(new Set((v.data ?? []).map((x: { sale_id: string }) => x.sale_id)))
    if (!m.error) setMethods(new Map((m.data ?? []).map((x: { id: string; name: string }) => [x.id, x.name])))
  }, [ev.event_id])

  useEffect(() => {
    load()
  }, [load])

  async function addProduct() {
    const p = opts.find((x) => x.id === addId)
    if (!p) return
    const price = p.current_price ?? p.suggested_price ?? 0
    const { error } = await supabase.from('event_products').insert({ event_id: ev.event_id, product_id: p.id, price, qty_brought: 0 })
    if (error) return setError(friendlyError(error.message))
    setAddId('')
    load()
  }
  async function updateProduct(productId: string, patch: { price?: string; qty_brought?: number }) {
    const { error } = await supabase.from('event_products').update(patch).eq('event_id', ev.event_id).eq('product_id', productId)
    if (error) return setError(friendlyError(error.message))
    load()
  }
  async function removeProduct(productId: string) {
    const { error } = await supabase.from('event_products').delete().eq('event_id', ev.event_id).eq('product_id', productId)
    if (error) return setError(friendlyError(error.message))
    load()
  }
  async function copy() {
    if (!copyFrom) return
    const { data, error } = await supabase.rpc('copy_event_products', { p_from: copyFrom, p_to: ev.event_id })
    if (error) return setError(friendlyError(error.message))
    setCopyFrom('')
    setOk(`Se copiaron ${data} productos con sus precios.`)
    load()
  }
  async function setStatus(status: 'open' | 'closed') {
    if (status === 'closed' && !window.confirm('¿Cerrar el bazar? Ya no se podrán registrar ventas en él.')) return
    const { error } = await supabase.from('events').update({ status }).eq('id', ev.event_id)
    if (error) return setError(friendlyError(error.message))
    props.onChanged()
  }
  async function voidSale(id: string) {
    const reason = window.prompt('¿Por qué anulas esta venta? (opcional)')
    if (reason === null) return
    const { error } = await supabase.rpc('void_sale', { p_sale_id: id, p_reason: reason.trim() || null })
    if (error) return setError(friendlyError(error.message))
    setOk('Venta anulada: la existencia regresó.')
    load()
    props.onChanged()
  }

  const inList = new Set(list.map((x) => x.product_id))
  const addable = opts.filter((o) => o.is_active && !inList.has(o.id))
  const sellList: EventProduct[] = list.map((x) => ({
    product_id: x.product_id,
    name: x.name,
    kind: x.kind,
    price: Number(x.price),
    qty_brought: x.qty_brought,
    qty_remaining: x.qty_remaining,
  }))

  return (
    <Modal title={`${ev.name} · ${ev.event_date}`} onClose={props.onClose}>
      <ErrorBox message={error} />
      <OkBox message={ok} />
      <div className="actions left">
        {open && (
          <button className="primary" onClick={() => setSelling(true)}>
            Vender
          </button>
        )}
        <button onClick={() => setEditing(true)}>Datos del bazar</button>
        {open ? <button onClick={() => setStatus('closed')}>Cerrar bazar</button> : <button onClick={() => setStatus('open')}>Reabrir</button>}
      </div>
      {!open && <p className="muted small">Bazar cerrado: ya no se registran ventas.</p>}

      <h3>Resumen</h3>
      <ul className="kv">
        <li>
          <span>Tickets</span>
          <b>{ev.tickets}</b>
        </li>
        <li>
          <span>Vendido</span>
          <b>{money(ev.gross)}</b>
        </li>
        <li>
          <span>Comisiones de tarjeta</span>
          <b>{money(ev.card_fees)}</b>
        </li>
        <li>
          <span>Costo de lo vendido (incluye tu mano de obra de {money(ev.labor_in_cost)})</span>
          <b>{money(ev.cost_of_goods)}</b>
        </li>
        <li>
          <span>Mesa</span>
          <b>{money(ev.table_cost)}</b>
        </li>
        <li>
          <span>Utilidad del bazar</span>
          <b>{money(ev.profit)}</b>
        </li>
        <li>
          <span>
            Efectivo esperado en caja (fondo {money(ev.float_cash)} + efectivo {money(ev.cash_sales)})
          </span>
          <b>{money(ev.expected_cash)}</b>
        </li>
        <li>
          <span>Cobrado con tarjeta (llega después, menos comisión)</span>
          <b>{money(ev.card_sales)}</b>
        </li>
      </ul>

      <h3>Lista de precios y piezas de este bazar</h3>
      <p className="hint">El precio se decide aquí, bazar por bazar. Al agregar un producto empieza con su precio de referencia o el sugerido.</p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Producto</th>
              <th>Precio</th>
              <th>Llevo</th>
              <th>Vendidas</th>
              <th>Quedan</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((x) => (
              <tr key={x.product_id}>
                <td>
                  {x.name}
                  {x.kind === 'packaging' && <span className="pill">bolsa</span>}
                </td>
                <td style={{ width: 110 }}>
                  <input
                    inputMode="decimal"
                    defaultValue={x.price}
                    onBlur={(e) => {
                      if (isNonNegativeNumber(e.target.value) && Number(e.target.value) !== Number(x.price)) updateProduct(x.product_id, { price: e.target.value })
                    }}
                  />
                </td>
                <td style={{ width: 90 }}>
                  <input
                    inputMode="numeric"
                    defaultValue={x.qty_brought}
                    onBlur={(e) => {
                      const n = Math.floor(Number(e.target.value))
                      if (Number.isFinite(n) && n >= 0 && n !== x.qty_brought) updateProduct(x.product_id, { qty_brought: n })
                    }}
                  />
                </td>
                <td>{x.qty_sold}</td>
                <td>{x.kind === 'packaging' ? '—' : x.qty_remaining}</td>
                <td>
                  <button onClick={() => removeProduct(x.product_id)}>Quitar</button>
                </td>
              </tr>
            ))}
            {list.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  Aún no hay productos en este bazar.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="inline-form">
        <select value={addId} onChange={(e) => setAddId(e.target.value)}>
          <option value="">Agregar producto...</option>
          {addable.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
              {o.current_price ?? o.suggested_price ? ` (${money(o.current_price ?? o.suggested_price, 0)})` : ''}
            </option>
          ))}
        </select>
        <button onClick={addProduct} disabled={!addId}>
          Agregar
        </button>
      </div>
      <div className="inline-form">
        <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
          <option value="">Copiar lista de otro bazar...</option>
          {props.others.map((o) => (
            <option key={o.event_id} value={o.event_id}>
              {o.name} ({o.event_date})
            </option>
          ))}
        </select>
        <button onClick={copy} disabled={!copyFrom}>
          Copiar
        </button>
      </div>

      <h3>Ventas</h3>
      {sales.length === 0 ? (
        <p className="muted">Sin ventas todavía.</p>
      ) : (
        <ul className="list">
          {sales.map((s) => {
            const isVoid = voided.has(s.id)
            return (
              <li key={s.id} className={isVoid ? 'inactive' : ''}>
                <span>
                  <b>{money(s.total)}</b> · {new Date(s.sold_at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })} ·{' '}
                  {methods.get(s.payment_method_id)}
                  {s.card_fee > 0 && <span className="muted small"> (comisión {money(s.card_fee)})</span>}
                  {isVoid && <span className="pill">anulada</span>}
                  <br />
                  <span className="muted small">
                    {lines
                      .filter((l) => l.sale_id === s.id)
                      .map((l) => `${l.qty}× ${l.description}${l.line_type === 'packaging' && !l.delivered ? ' (sin entregar)' : ''}`)
                      .join(', ')}
                  </span>
                </span>
                {!isVoid && <button onClick={() => voidSale(s.id)}>Anular</button>}
              </li>
            )
          })}
        </ul>
      )}

      {selling && (
        <Sell
          eventId={ev.event_id}
          eventName={ev.name}
          products={sellList}
          onSold={() => {
            load()
            props.onChanged()
          }}
          onClose={() => setSelling(false)}
        />
      )}
      {editing && (
        <EventForm
          event={ev}
          onSaved={() => {
            setEditing(false)
            props.onChanged()
          }}
          onClose={() => setEditing(false)}
        />
      )}
    </Modal>
  )
}

export default function Events() {
  const [rows, setRows] = useState<Summary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError('')
    const { data, error } = await supabase.from('v_event_summary').select('*').order('event_date', { ascending: false })
    if (error) setError(friendlyError(error.message))
    else setRows((data ?? []) as Summary[])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const open = rows.find((r) => r.event_id === openId) ?? null

  return (
    <div>
      <div className="section-head">
        <h2>Bazares</h2>
        <button className="primary" onClick={() => setCreating(true)}>
          + Nuevo bazar
        </button>
      </div>
      <ErrorBox message={error} />
      {loading ? (
        <p className="muted">Cargando...</p>
      ) : rows.length === 0 ? (
        <p className="muted">Aún no hay bazares. Crea el primero con “Nuevo bazar”.</p>
      ) : (
        <div className="table-wrap">
          <table className="table clickable">
            <thead>
              <tr>
                <th>Bazar</th>
                <th>Fecha</th>
                <th>Tickets</th>
                <th>Vendido</th>
                <th>Utilidad</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.event_id} onClick={() => setOpenId(r.event_id)}>
                  <td>{r.name}</td>
                  <td>{r.event_date}</td>
                  <td>{r.tickets}</td>
                  <td>{money(r.gross)}</td>
                  <td>{money(r.profit)}</td>
                  <td>{r.status === 'open' ? 'Abierto' : 'Cerrado'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && (
        <EventForm
          event={null}
          onSaved={() => {
            setCreating(false)
            load()
          }}
          onClose={() => setCreating(false)}
        />
      )}
      {open && <EventDetail summary={open} others={rows.filter((r) => r.event_id !== open.event_id)} onChanged={load} onClose={() => setOpenId(null)} />}
    </div>
  )
}
