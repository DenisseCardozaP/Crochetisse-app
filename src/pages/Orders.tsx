import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import Decimal from 'decimal.js'
import { supabase } from '../supabase'
import { friendlyError, isNonNegativeNumber, isPositiveNumber, money, todayMX } from '../format'
import { ErrorBox, Field, Modal, OkBox } from '../ui'

type Status = 'quote' | 'confirmed' | 'delivered' | 'cancelled'

const STATUS_LABEL: Record<Status, string> = {
  quote: 'Cotización',
  confirmed: 'Pedido confirmado',
  delivered: 'Entregado',
  cancelled: 'Cancelado',
}

interface Summary {
  id: string
  quote_folio: string
  order_folio: string | null
  status: Status
  customer_name: string
  customer_phone: string | null
  notes: string | null
  due_date: string | null
  total: number
  paid: number
  balance: number
  fees: number
  concretized: boolean
  concretized_on: string | null
  delivered_on: string | null
  cost_real: number | null
  labor_real: number | null
  cost_estimated: number | null
}
interface LineRow {
  id: string
  sort_no: number
  line_type: 'product' | 'packaging' | 'custom'
  product_id: string | null
  description: string
  qty: number
  unit_price: number
  line_total: number
  custom_unit_cost: number
}
interface CompRow {
  line_id: string
  component_product_id: string
  qty: number
}
interface PaymentRow {
  id: string
  kind: 'payment' | 'refund'
  amount: number
  payment_method_id: string
  paid_on: string
  fee: number
  note: string | null
}
interface ProductOpt {
  id: string
  name: string
  kind: string
  is_active: boolean
  has_recipe: boolean | null
  current_price: number | null
  suggested_price: number | null
}
interface Method {
  id: string
  name: string
  kind: string
}

interface DraftComp {
  productId: string
  qty: string
}
interface DraftLine {
  key: string
  type: 'product' | 'packaging' | 'custom'
  productId: string
  description: string
  qty: string
  price: string
  unitCost: string
  custom: boolean
  comps: DraftComp[]
}

const D = (s: string | number | null | undefined): Decimal => {
  try {
    return new Decimal(s === '' || s == null ? '0' : String(s))
  } catch {
    return new Decimal(0)
  }
}
const folioOf = (o: Summary) => o.order_folio ?? o.quote_folio

// ---------------------------------------------------------------- cotizar / editar
// El precio se decide para el pedido completo. Los renglones solo dicen QUÉ lleva el pedido.
function OrderForm(props: { order: Summary | null; products: ProductOpt[]; onSaved: (id: string) => void; onClose: () => void }) {
  const o0 = props.order
  const [customer, setCustomer] = useState(o0?.customer_name ?? '')
  const [phone, setPhone] = useState(o0?.customer_phone ?? '')
  const [due, setDue] = useState(o0?.due_date ?? '')
  const [notes, setNotes] = useState(o0?.notes ?? '')
  const [lines, setLines] = useState<DraftLine[]>([])
  const [bagId, setBagId] = useState('')
  const [total, setTotal] = useState(o0 ? String(o0.total) : '')
  const [loaded, setLoaded] = useState(!o0)
  const [estTotal, setEstTotal] = useState<number | null>(null)
  const [suggest, setSuggest] = useState<number | null>(null)
  const [withCard, setWithCard] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const goods = props.products.filter((p) => p.is_active && p.kind !== 'packaging')
  const bags = props.products.filter((p) => p.is_active && p.kind === 'packaging')
  const byId = useMemo(() => new Map(props.products.map((p) => [p.id, p])), [props.products])
  const isGroup = (id: string) => {
    const k = byId.get(id)?.kind
    return k === 'assembly' || k === 'bundle'
  }

  useEffect(() => {
    if (!o0) return
    let alive = true
    ;(async () => {
      const [l, c] = await Promise.all([
        supabase
          .from('order_lines')
          .select('id, sort_no, line_type, product_id, description, qty, unit_price, line_total, custom_unit_cost')
          .eq('order_id', o0.id)
          .order('sort_no'),
        supabase.from('order_line_components').select('line_id, component_product_id, qty'),
      ])
      if (!alive) return
      if (l.error) return setError(friendlyError(l.error.message))
      const comps = (c.data ?? []) as CompRow[]
      const rows = (l.data ?? []) as LineRow[]
      setBagId(rows.find((x) => x.line_type === 'packaging')?.product_id ?? '')
      setLines(
        rows
          .filter((x) => x.line_type !== 'packaging')
          .map((x) => ({
            key: x.id,
            type: x.line_type,
            productId: x.product_id ?? '',
            description: x.description,
            qty: String(x.qty),
            price: '',
            unitCost: String(x.custom_unit_cost),
            custom: false,
            comps: comps.filter((k) => k.line_id === x.id).map((k) => ({ productId: k.component_product_id, qty: String(k.qty) })),
          })),
      )
      setLoaded(true)
    })()
    return () => {
      alive = false
    }
  }, [o0])

  function payload() {
    const out: Record<string, unknown>[] = lines.map((l) => {
      if (l.type === 'custom') return { type: 'custom', description: l.description, qty: l.qty, unit_cost: l.unitCost || '0' }
      const base: Record<string, unknown> = { type: 'product', product_id: l.productId, qty: l.qty }
      if (isGroup(l.productId) && l.comps.length > 0) base.components = l.comps.map((c) => ({ component_product_id: c.productId, qty: c.qty }))
      return base
    })
    if (bagId) out.push({ type: 'packaging', product_id: bagId, qty: 1 })
    return out
  }

  // costo estimado y precio sugerido de TODO el pedido (lo calcula la base de datos)
  useEffect(() => {
    const ready = lines.every((l) => (l.type === 'custom' ? l.description.trim() !== '' : l.productId !== '') && isPositiveNumber(l.qty))
    if (!ready || lines.length === 0) {
      setEstTotal(null)
      setSuggest(null)
      return
    }
    const t = window.setTimeout(async () => {
      const p = payload()
      const [e, s] = await Promise.all([
        supabase.rpc('estimate_lines', { p_lines: p }),
        supabase.rpc('suggest_order_price', { p_lines: p, p_include_card: withCard }),
      ])
      if (!e.error && Array.isArray(e.data)) setEstTotal((e.data as unknown[]).reduce<number>((a, v) => a + Number(v), 0))
      if (!s.error && s.data) setSuggest(Number((s.data as { suggested_price: number }).suggested_price))
    }, 400)
    return () => window.clearTimeout(t)
  }, [lines, bagId, withCard])

  function setLine(key: string, patch: Partial<DraftLine>) {
    setLines(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }
  function addLine(type: 'product' | 'custom') {
    setLines([...lines, { key: crypto.randomUUID(), type, productId: '', description: '', qty: '1', price: '', unitCost: '0', custom: false, comps: [] }])
  }
  // Al elegir un ramo/arreglo, sus piezas de la receta aparecen para que las cambies
  async function pickProduct(key: string, id: string) {
    setLine(key, { productId: id, comps: [] })
    if (!id || !isGroup(id)) return
    const { data } = await supabase.rpc('product_cost', { p_product_id: id })
    const pieces = ((data as { lines?: { type: string; id: string; qty: number }[] } | null)?.lines ?? [])
      .filter((x) => x.type === 'product')
      .map((x) => ({ productId: x.id, qty: String(x.qty) }))
    setLines((cur) => cur.map((l) => (l.key === key && l.productId === id ? { ...l, comps: pieces } : l)))
  }

  const totalD = D(total)
  const profit = estTotal === null ? null : totalD.minus(estTotal)
  const margin = profit && totalD.gt(0) ? profit.div(totalD).times(100) : null

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!customer.trim()) return setError('Escribe el nombre del cliente.')
    if (lines.length === 0) return setError('Agrega al menos un producto.')
    if (!isNonNegativeNumber(total)) return setError('Escribe el precio total del pedido.')
    for (const l of lines) {
      if (l.type !== 'custom' && !l.productId) return setError('Hay un renglón sin producto.')
      if (l.type === 'custom' && !l.description.trim()) return setError('Un renglón libre necesita descripción.')
      if (!isPositiveNumber(l.qty)) return setError('Las cantidades deben ser mayores a 0.')
      if (l.type === 'product' && isGroup(l.productId)) {
        if (l.comps.length === 0) return setError(`Agrega las piezas de ${byId.get(l.productId)?.name ?? 'el ramo'}.`)
        for (const c of l.comps) if (!c.productId || !isPositiveNumber(c.qty)) return setError('Revisa las piezas del ramo.')
      }
    }
    setBusy(true)
    setError('')
    const { data, error } = await supabase.rpc('save_order', {
      p_order_id: o0?.id ?? null,
      p_customer: customer.trim(),
      p_phone: phone.trim() || null,
      p_due: due || null,
      p_notes: notes.trim() || null,
      p_lines: payload(),
      p_total: total,
    })
    setBusy(false)
    if (error) return setError(friendlyError(error.message))
    props.onSaved(String(data))
  }

  return (
    <Modal title={o0 ? `Editar ${folioOf(o0)}` : 'Nueva cotización'} onClose={props.onClose}>
      {!loaded ? (
        <p className="muted">Cargando...</p>
      ) : (
        <form onSubmit={submit}>
          <div className="grid2">
            <Field label="Cliente">
              <input value={customer} onChange={(e) => setCustomer(e.target.value)} />
            </Field>
            <Field label="Teléfono (opcional)">
              <input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </Field>
            <Field label="Fecha de entrega (opcional)">
              <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </Field>
            <Field label="Notas (opcional)">
              <input value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </div>

          <h3>¿Qué lleva el pedido?</h3>
          {lines.map((l) => {
            const group = l.type === 'product' && isGroup(l.productId)
            return (
              <div key={l.key} className="group-card" style={{ margin: '8px 0', padding: '8px 12px' }}>
                <div className="grid2">
                  {l.type === 'custom' ? (
                    <Field label="Concepto extra (ej. envío)">
                      <input value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} />
                    </Field>
                  ) : (
                    <Field label="Producto">
                      <select value={l.productId} onChange={(e) => pickProduct(l.key, e.target.value)}>
                        <option value="">Elegir...</option>
                        {goods.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.name}
                            {x.has_recipe === false ? ' (sin receta)' : ''}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}
                  <Field label="Cantidad">
                    <input inputMode="decimal" value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} />
                  </Field>
                </div>
                {l.type === 'custom' && (
                  <Field label="Lo que te cuesta a ti (opcional, para calcular tu utilidad)">
                    <input inputMode="decimal" value={l.unitCost} onChange={(e) => setLine(l.key, { unitCost: e.target.value })} />
                  </Field>
                )}
                {group && (
                  <div style={{ marginTop: 4 }}>
                    <span className="label">Piezas del ramo (cámbialas a lo que pidió el cliente)</span>
                    {l.comps.map((c, ci) => (
                      <div key={ci} className="inline-form">
                        <select value={c.productId} onChange={(e) => setLine(l.key, { comps: l.comps.map((k, j) => (j === ci ? { ...k, productId: e.target.value } : k)) })}>
                          <option value="">Pieza...</option>
                          {goods.filter((x) => x.id !== l.productId).map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.name}
                            </option>
                          ))}
                        </select>
                        <input
                          style={{ maxWidth: 90 }}
                          inputMode="decimal"
                          value={c.qty}
                          onChange={(e) => setLine(l.key, { comps: l.comps.map((k, j) => (j === ci ? { ...k, qty: e.target.value } : k)) })}
                        />
                        <button type="button" onClick={() => setLine(l.key, { comps: l.comps.filter((_, j) => j !== ci) })}>
                          Quitar
                        </button>
                      </div>
                    ))}
                    <button type="button" onClick={() => setLine(l.key, { comps: [...l.comps, { productId: '', qty: '1' }] })}>
                      + Pieza
                    </button>
                  </div>
                )}
                <div className="actions left">
                  <button type="button" onClick={() => setLines(lines.filter((x) => x.key !== l.key))}>
                    Quitar renglón
                  </button>
                </div>
              </div>
            )
          })}
          <div className="actions left">
            <button type="button" onClick={() => addLine('product')}>
              + Producto
            </button>
            <button type="button" onClick={() => addLine('custom')}>
              + Concepto extra (envío, etc.)
            </button>
          </div>

          <Field label="Empaque (una bolsa por pedido; su costo siempre cuenta y está incluido en el precio)">
            <select value={bagId} onChange={(e) => setBagId(e.target.value)}>
              <option value="">Sin empaque</option>
              {bags.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>

          <h3>Precio del pedido</h3>
          <ul className="kv">
            <li>
              <span>Costo estimado (materiales + tu mano de obra + empaque)</span>
              <b>{estTotal === null ? '—' : money(estTotal)}</b>
            </li>
            <li>
              <span>Precio sugerido con tu ganancia</span>
              <b>
                {suggest === null ? '—' : money(suggest)}{' '}
                {suggest !== null && (
                  <button type="button" onClick={() => setTotal(String(suggest))}>
                    Usar
                  </button>
                )}
              </b>
            </li>
          </ul>
          <label className="inline">
            <input type="checkbox" checked={withCard} onChange={(e) => setWithCard(e.target.checked)} /> Incluir comisión de tarjeta en el sugerido
          </label>
          <Field label="Precio total del pedido que le das al cliente">
            <input inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} />
          </Field>
          {profit && (
            <p className="hint">
              Tu utilidad con este precio: <b>{money(profit.toFixed(2))}</b>
              {margin ? ` (${margin.toFixed(0)}% del precio)` : ''}. Incluye el pago de tus horas dentro del costo.
            </p>
          )}
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
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------- pago
function PaymentForm(props: { order: Summary; methods: Method[]; refund: boolean; onSaved: () => void; onClose: () => void }) {
  const [amount, setAmount] = useState(props.refund ? '' : String(props.order.balance))
  const [methodId, setMethodId] = useState(props.methods.find((m) => m.kind === 'transfer')?.id ?? props.methods[0]?.id ?? '')
  const [date, setDate] = useState(todayMX())
  const [note, setNote] = useState('')
  const [clientId] = useState(() => crypto.randomUUID())
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!isPositiveNumber(amount)) return setError('Escribe un monto mayor a 0.')
    setBusy(true)
    setError('')
    const { error } = await supabase.rpc('record_order_payment', {
      p_order_id: props.order.id,
      p_amount: amount,
      p_method: methodId,
      p_date: date,
      p_note: note.trim() || null,
      p_kind: props.refund ? 'refund' : 'payment',
      p_client_uuid: clientId,
    })
    setBusy(false)
    if (error) return setError(friendlyError(error.message))
    props.onSaved()
  }

  return (
    <Modal title={props.refund ? 'Registrar devolución' : 'Registrar pago'} onClose={props.onClose}>
      <p className="muted small">
        {folioOf(props.order)} · Total {money(props.order.total)} · Pagado {money(props.order.paid)} · Saldo {money(props.order.balance)}
      </p>
      <form onSubmit={submit}>
        <div className="grid3">
          <Field label="Monto">
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Forma de pago">
            <select value={methodId} onChange={(e) => setMethodId(e.target.value)}>
              {props.methods.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Fecha">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Nota (ej. anticipo)">
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
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

// ---------------------------------------------------------------- detalle
function OrderDetail(props: { order: Summary; products: ProductOpt[]; methods: Method[]; onChanged: () => void; onClose: () => void }) {
  const o = props.order
  const [lines, setLines] = useState<LineRow[]>([])
  const [comps, setComps] = useState<CompRow[]>([])
  const [payments, setPayments] = useState<PaymentRow[]>([])
  const [stock, setStock] = useState<Map<string, number>>(new Map())
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')
  const [dlg, setDlg] = useState<'' | 'edit' | 'pay' | 'refund'>('')
  const [busy, setBusy] = useState(false)
  const pname = useMemo(() => new Map(props.products.map((p) => [p.id, p.name])), [props.products])
  const mname = useMemo(() => new Map(props.methods.map((m) => [m.id, m.name])), [props.methods])

  const load = useCallback(async () => {
    const [l, c, p, s] = await Promise.all([
      supabase.from('order_lines').select('id, sort_no, line_type, product_id, description, qty, unit_price, line_total, custom_unit_cost').eq('order_id', o.id).order('sort_no'),
      supabase.from('order_line_components').select('line_id, component_product_id, qty'),
      supabase.from('order_payments').select('id, kind, amount, payment_method_id, paid_on, fee, note').eq('order_id', o.id).order('paid_on'),
      supabase.from('v_product_stock').select('product_id, stock_qty'),
    ])
    if (l.error) setError(friendlyError(l.error.message))
    else setLines((l.data ?? []) as LineRow[])
    if (!c.error) setComps((c.data ?? []) as CompRow[])
    if (!p.error) setPayments((p.data ?? []) as PaymentRow[])
    if (!s.error) setStock(new Map((s.data ?? []).map((x: { product_id: string; stock_qty: number }) => [x.product_id, Number(x.stock_qty)])))
  }, [o.id])

  useEffect(() => {
    load()
  }, [load, o.status, o.total])

  async function run(fn: () => PromiseLike<{ error: { message: string } | null }>, msg: string) {
    setBusy(true)
    setError('')
    const { error } = await fn()
    setBusy(false)
    if (error) return setError(friendlyError(error.message))
    setOk(msg)
    props.onChanged()
    load()
  }

  function availability(l: LineRow): string {
    if (l.line_type !== 'product' || !l.product_id) return ''
    const custom = comps.some((c) => c.line_id === l.id)
    if (custom) return 'personalizado: se arma al entregar'
    const have = Math.max(stock.get(l.product_id) ?? 0, 0)
    const need = Number(l.qty)
    if (have >= need) return `hay ${have} terminados`
    return `hay ${have} terminados; se tejen ${need - have} al entregar`
  }

  const editable = o.status === 'quote' || o.status === 'confirmed'

  return (
    <Modal title={`${folioOf(o)} · ${o.customer_name}`} onClose={props.onClose}>
      <p className="muted small">
        {STATUS_LABEL[o.status]}
        {o.order_folio ? ` · cotización ${o.quote_folio}` : ''}
        {o.due_date ? ` · entrega ${o.due_date}` : ''}
        {o.customer_phone ? ` · ${o.customer_phone}` : ''}
      </p>
      {o.notes && <p>{o.notes}</p>}
      <ErrorBox message={error} />
      <OkBox message={ok} />

      <div className="actions left">
        {editable && <button onClick={() => setDlg('edit')}>Editar</button>}
        {o.status === 'quote' && (
          <button
            className="primary"
            disabled={busy}
            onClick={() => run(() => supabase.rpc('confirm_order', { p_order_id: o.id }), 'Pedido confirmado: ya tiene folio PED.')}
          >
            Confirmar pedido
          </button>
        )}
        {(o.status === 'confirmed' || o.status === 'delivered') && o.balance > 0 && <button onClick={() => setDlg('pay')}>Registrar pago</button>}
        {(o.status === 'confirmed' || o.status === 'delivered') && o.paid > 0 && <button onClick={() => setDlg('refund')}>Devolución</button>}
        {o.status === 'confirmed' && (
          <button
            className="primary"
            disabled={busy}
            onClick={() => {
              if (window.confirm('¿Marcar como entregado? Se descuentan materiales y producto terminado (lo que falte se teje en ese momento).'))
                run(() => supabase.rpc('deliver_order', { p_order_id: o.id }), 'Pedido entregado: inventario y costo real guardados.')
            }}
          >
            Entregar
          </button>
        )}
        {editable && (
          <button
            disabled={busy}
            onClick={() => {
              const reason = window.prompt('¿Por qué lo cancelas? (opcional)')
              if (reason !== null) run(() => supabase.rpc('cancel_order', { p_order_id: o.id, p_reason: reason.trim() || null }), 'Cancelado.')
            }}
          >
            Cancelar
          </button>
        )}
      </div>

      <h3>Renglones</h3>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Concepto</th>
              <th>Cant.</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id}>
                <td>
                  {l.description}
                  {l.line_type === 'packaging' && <span className="pill">bolsa</span>}
                  {comps.filter((c) => c.line_id === l.id).length > 0 && (
                    <div className="muted small">
                      Piezas: {comps.filter((c) => c.line_id === l.id).map((c) => `${c.qty}× ${pname.get(c.component_product_id) ?? '—'}`).join(', ')}
                    </div>
                  )}
                  {o.status === 'confirmed' && <div className="muted small">{availability(l)}</div>}
                </td>
                <td>{l.qty}</td>
              </tr>
            ))}
            <tr>
              <th>Precio del pedido</th>
              <th>{money(o.total)}</th>
            </tr>
          </tbody>
        </table>
      </div>

      <h3>Pagos</h3>
      {payments.length === 0 ? (
        <p className="muted">Sin pagos todavía.</p>
      ) : (
        <ul className="list compact">
          {payments.map((p) => (
            <li key={p.id}>
              <span>
                {p.paid_on} · {mname.get(p.payment_method_id)} {p.note ? `· ${p.note}` : ''}
                {p.fee > 0 && <span className="muted small"> (comisión {money(p.fee)})</span>}
              </span>
              <b>{p.kind === 'refund' ? '−' : ''}{money(p.amount)}</b>
            </li>
          ))}
        </ul>
      )}
      <ul className="kv">
        <li>
          <span>Pagado</span>
          <b>{money(o.paid)}</b>
        </li>
        <li>
          <span>Saldo</span>
          <b>{money(o.balance)}</b>
        </li>
        {o.status === 'delivered' && (
          <>
            <li>
              <span>Estado</span>
              <b>{o.concretized ? `Concretado el ${o.concretized_on}` : 'Entregado, falta cobrar el saldo'}</b>
            </li>
            <li>
              <span>Costo real (incluye tu mano de obra de {money(o.labor_real)})</span>
              <b>{money(o.cost_real)}</b>
            </li>
            <li>
              <span>Utilidad real</span>
              <b>{money(new Decimal(o.total).minus(o.cost_real ?? 0).minus(o.fees).toFixed(2))}</b>
            </li>
          </>
        )}
        {editable && o.cost_estimated !== null && (
          <li>
            <span>Utilidad estimada (total − costo estimado)</span>
            <b>{money(new Decimal(o.total).minus(o.cost_estimated).toFixed(2))}</b>
          </li>
        )}
      </ul>
      <p className="hint">Un anticipo no cuenta como venta: el pedido cuenta para tus ganancias cuando está entregado y pagado completo.</p>

      {dlg === 'edit' && (
        <OrderForm
          order={o}
          products={props.products}
          onSaved={() => {
            setDlg('')
            setOk('Cambios guardados.')
            props.onChanged()
            load()
          }}
          onClose={() => setDlg('')}
        />
      )}
      {(dlg === 'pay' || dlg === 'refund') && (
        <PaymentForm
          order={o}
          methods={props.methods}
          refund={dlg === 'refund'}
          onSaved={() => {
            setDlg('')
            setOk(dlg === 'refund' ? 'Devolución registrada.' : 'Pago registrado.')
            props.onChanged()
            load()
          }}
          onClose={() => setDlg('')}
        />
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------- lista
export default function Orders() {
  const [rows, setRows] = useState<Summary[]>([])
  const [products, setProducts] = useState<ProductOpt[]>([])
  const [methods, setMethods] = useState<Method[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<'active' | Status | 'all'>('active')
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError('')
    const [s, p, m] = await Promise.all([
      supabase.from('v_order_summary').select('*').order('created_at', { ascending: false }),
      supabase.from('v_product_overview').select('id, name, kind, is_active, has_recipe, current_price, suggested_price').order('name'),
      supabase.from('payment_methods').select('id, name, kind').eq('is_active', true).order('sort_order'),
    ])
    if (s.error) setError(friendlyError(s.error.message))
    else setRows((s.data ?? []) as Summary[])
    if (!p.error) setProducts((p.data ?? []) as ProductOpt[])
    if (!m.error) setMethods((m.data ?? []) as Method[])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const shown = rows.filter((r) => {
    if (filter === 'active' && !(r.status === 'quote' || r.status === 'confirmed' || (r.status === 'delivered' && !r.concretized))) return false
    if (filter !== 'active' && filter !== 'all' && r.status !== filter) return false
    const text = `${r.customer_name} ${r.quote_folio} ${r.order_folio ?? ''}`.toLowerCase()
    return !search || text.includes(search.toLowerCase())
  })
  const open = rows.find((r) => r.id === openId) ?? null
  const today = todayMX()

  return (
    <div>
      <div className="section-head">
        <h2>Pedidos y cotizaciones</h2>
        <button className="primary" onClick={() => setCreating(true)}>
          + Nueva cotización
        </button>
      </div>
      <div className="filters">
        <input placeholder="Buscar cliente o folio..." value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="active">Pendientes (cotizaciones, por entregar, por cobrar)</option>
          <option value="all">Todos</option>
          <option value="quote">Cotizaciones</option>
          <option value="confirmed">Por entregar</option>
          <option value="delivered">Entregados</option>
          <option value="cancelled">Cancelados</option>
        </select>
      </div>
      <ErrorBox message={error} />
      {loading ? (
        <p className="muted">Cargando...</p>
      ) : shown.length === 0 ? (
        <p className="muted">No hay pedidos en esta vista.</p>
      ) : (
        <div className="table-wrap">
          <table className="table clickable">
            <thead>
              <tr>
                <th>Folio</th>
                <th>Cliente</th>
                <th>Entrega</th>
                <th>Total</th>
                <th>Saldo</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className={r.status === 'cancelled' ? 'inactive' : ''} onClick={() => setOpenId(r.id)}>
                  <td>{folioOf(r)}</td>
                  <td>{r.customer_name}</td>
                  <td>
                    {r.due_date ?? '—'}
                    {r.status === 'confirmed' && r.due_date && r.due_date < today && <span className="pill">atrasado</span>}
                  </td>
                  <td>{money(r.total)}</td>
                  <td>{r.status === 'cancelled' || r.status === 'quote' ? '—' : money(r.balance)}</td>
                  <td>{r.status === 'delivered' ? (r.concretized ? 'Concretado' : 'Entregado · por cobrar') : STATUS_LABEL[r.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && (
        <OrderForm
          order={null}
          products={products}
          onSaved={(id) => {
            setCreating(false)
            load().then(() => setOpenId(id))
          }}
          onClose={() => setCreating(false)}
        />
      )}
      {open && <OrderDetail order={open} products={products} methods={methods} onChanged={load} onClose={() => setOpenId(null)} />}
    </div>
  )
}
