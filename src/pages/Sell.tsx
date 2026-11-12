import { useEffect, useMemo, useState } from 'react'
import Decimal from 'decimal.js'
import { supabase } from '../supabase'
import { friendlyError, isNonNegativeNumber, money } from '../format'
import { ErrorBox } from '../ui'

export interface EventProduct {
  product_id: string
  name: string
  kind: string
  price: number
  qty_brought: number
  qty_remaining: number
}
interface YarnItem {
  id: string
  name: string
  brand: string | null
  color: string | null
  price_group_id: string | null
}
interface Tier {
  group_id: string
  min_qty: number
  unit_price: number
}
interface Method {
  id: string
  code: string
  name: string
  kind: string
}
interface FeeRate {
  payment_method_id: string
  pct: number
  fixed_fee: number
  vat_on_fee: boolean
}
interface Row {
  key: string
  productId: string
  name: string
  qty: number
  price: string
}
interface YarnRow {
  itemId: string
  qty: number
}

const D = (s: string | number): Decimal => {
  try {
    return new Decimal(s === '' ? '0' : String(s))
  } catch {
    return new Decimal(0)
  }
}

// Tablet/PC: pantalla completa para vender
export default function Sell(props: {
  eventId: string | null
  eventName: string
  products: EventProduct[]
  onSold: () => void
  onClose: () => void
}) {
  const [methods, setMethods] = useState<Method[]>([])
  const [rates, setRates] = useState<FeeRate[]>([])
  const [yarn, setYarn] = useState<YarnItem[]>([])
  const [tiers, setTiers] = useState<Tier[]>([])
  const [rows, setRows] = useState<Row[]>([])
  const [yarnRows, setYarnRows] = useState<YarnRow[]>([])
  const [bagId, setBagId] = useState('')
  const [bagDelivered, setBagDelivered] = useState(true)
  const [bagPrice, setBagPrice] = useState('')
  const [methodId, setMethodId] = useState('')
  const [received, setReceived] = useState('')
  const [note, setNote] = useState('')
  const [yarnPick, setYarnPick] = useState('')
  const [error, setError] = useState('')
  const [lastOk, setLastOk] = useState('')
  const [busy, setBusy] = useState(false)
  const [clientId, setClientId] = useState(() => crypto.randomUUID())

  useEffect(() => {
    Promise.all([
      supabase.from('payment_methods').select('id, code, name, kind').eq('is_active', true).order('sort_order'),
      supabase.from('v_payment_method_current_rate').select('payment_method_id, pct, fixed_fee, vat_on_fee'),
      supabase.from('items').select('id, name, brand, color, price_group_id').eq('kind', 'resale').eq('is_active', true).order('color'),
      supabase.from('v_group_prices_current').select('group_id, min_qty, unit_price').eq('audience', 'customer'),
    ]).then(([m, r, y, t]) => {
      if (m.error) setError(friendlyError(m.error.message))
      else {
        const list = (m.data ?? []) as Method[]
        setMethods(list)
        setMethodId(list.find((x) => x.kind === 'cash')?.id ?? list[0]?.id ?? '')
      }
      if (!r.error) setRates((r.data ?? []) as FeeRate[])
      if (!y.error) setYarn((y.data ?? []) as YarnItem[])
      if (!t.error) setTiers((t.data ?? []) as Tier[])
    })
  }, [])

  const bags = props.products.filter((p) => p.kind === 'packaging')
  const goods = props.products.filter((p) => p.kind !== 'packaging')
  const method = methods.find((m) => m.id === methodId)

  function add(p: EventProduct) {
    const ex = rows.find((r) => r.productId === p.product_id)
    if (ex) setRows(rows.map((r) => (r === ex ? { ...r, qty: r.qty + 1 } : r)))
    else setRows([...rows, { key: crypto.randomUUID(), productId: p.product_id, name: p.name, qty: 1, price: String(p.price) }])
  }
  function setRow(key: string, patch: Partial<Row>) {
    setRows(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)).filter((r) => r.qty > 0))
  }

  // escalón de estambre: se cuentan todas las madejas del mismo grupo
  const groupQty = new Map<string, number>()
  for (const yr of yarnRows) {
    const it = yarn.find((i) => i.id === yr.itemId)
    if (it?.price_group_id) groupQty.set(it.price_group_id, (groupQty.get(it.price_group_id) ?? 0) + yr.qty)
  }
  function yarnPrice(itemId: string): number | null {
    const it = yarn.find((i) => i.id === itemId)
    if (!it?.price_group_id) return null
    const q = groupQty.get(it.price_group_id) ?? 0
    const t = tiers.filter((x) => x.group_id === it.price_group_id && x.min_qty <= q).sort((a, b) => b.min_qty - a.min_qty)[0]
    return t ? Number(t.unit_price) : null
  }

  const goodsTotal = rows.reduce((a, r) => a.plus(D(r.price).times(r.qty)), new Decimal(0))
  const yarnTotal = yarnRows.reduce((a, y) => a.plus(D(yarnPrice(y.itemId) ?? 0).times(y.qty)), new Decimal(0))
  const bagTotal = bagId ? D(bagPrice) : new Decimal(0)
  const total = goodsTotal.plus(yarnTotal).plus(bagTotal)
  const rate = rates.find((r) => r.payment_method_id === methodId)
  const fee = rate
    ? D(rate.pct).times(total).plus(rate.fixed_fee).times(rate.vat_on_fee ? 1.16 : 1).toDecimalPlaces(2)
    : new Decimal(0)
  const change = method?.kind === 'cash' && received !== '' ? D(received).minus(total) : null

  function reset() {
    setRows([])
    setYarnRows([])
    setBagId('')
    setBagPrice('')
    setBagDelivered(true)
    setReceived('')
    setNote('')
    setClientId(crypto.randomUUID())
  }

  function pickBag(id: string) {
    setBagId(id)
    const b = bags.find((x) => x.product_id === id)
    setBagPrice(b ? String(b.price) : '')
  }

  async function charge() {
    setError('')
    if (rows.length === 0 && yarnRows.length === 0) return setError('Agrega al menos un producto.')
    for (const r of rows) if (!isNonNegativeNumber(r.price)) return setError(`Revisa el precio de ${r.name}.`)
    if (bagId && !isNonNegativeNumber(bagPrice)) return setError('Revisa el precio de la bolsa.')
    for (const y of yarnRows) if (yarnPrice(y.itemId) === null) return setError('Un estambre no tiene precio vigente.')
    setBusy(true)
    const lines: Record<string, unknown>[] = [
      ...rows.map((r) => ({ type: 'product', product_id: r.productId, qty: r.qty, unit_price: r.price })),
      ...yarnRows.map((y) => ({ type: 'item', item_id: y.itemId, qty: y.qty })),
    ]
    if (bagId) lines.push({ type: 'packaging', product_id: bagId, qty: 1, unit_price: bagPrice, delivered: bagDelivered })
    const { error } = await supabase.rpc('register_sale', {
      p_event_id: props.eventId,
      p_payment_method_id: methodId,
      p_lines: lines,
      p_note: note.trim() || null,
      p_client_uuid: clientId,
    })
    setBusy(false)
    if (error) return setError(friendlyError(error.message))
    setLastOk(`Venta guardada: ${money(total.toFixed(2))}`)
    reset()
    props.onSold()
  }

  const yarnName = useMemo(() => new Map(yarn.map((i) => [i.id, [i.name, i.brand, i.color].filter(Boolean).join(' · ')])), [yarn])

  return (
    <div className="modal-back" style={{ alignItems: 'stretch', padding: 8 }}>
      <div className="modal" style={{ maxWidth: 1100, background: 'var(--bg)' }}>
        <div className="modal-head">
          <h2>Vender · {props.eventName}</h2>
          <button onClick={props.onClose}>Cerrar</button>
        </div>
        {lastOk && <p className="ok-box">{lastOk}</p>}
        <div className="pos">
          <div>
            <h3>Productos</h3>
            <div className="tiles">
              {goods.map((p) => (
                <button key={p.product_id} className="tile" onClick={() => add(p)}>
                  <b>{p.name}</b>
                  <span>{money(p.price, 0)}</span>
                  <span className={p.qty_remaining <= 0 ? 'tile-low' : 'muted small'}>quedan {p.qty_remaining}</span>
                </button>
              ))}
              {goods.length === 0 && <p className="muted">Este bazar no tiene productos en su lista.</p>}
            </div>
            <h3>Estambre</h3>
            <div className="inline-form">
              <select value={yarnPick} onChange={(e) => setYarnPick(e.target.value)}>
                <option value="">Elegir color...</option>
                {yarn.map((i) => (
                  <option key={i.id} value={i.id}>
                    {[i.brand, i.color].filter(Boolean).join(' · ')}
                  </option>
                ))}
              </select>
              <button
                onClick={() => {
                  if (!yarnPick) return
                  const ex = yarnRows.find((y) => y.itemId === yarnPick)
                  setYarnRows(ex ? yarnRows.map((y) => (y === ex ? { ...y, qty: y.qty + 1 } : y)) : [...yarnRows, { itemId: yarnPick, qty: 1 }])
                }}
              >
                Agregar madeja
              </button>
            </div>
          </div>
          <div>
            <h3>Ticket</h3>
            <table className="table">
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td>{r.name}</td>
                    <td>
                      <button onClick={() => setRow(r.key, { qty: r.qty - 1 })}>−</button> {r.qty}{' '}
                      <button onClick={() => setRow(r.key, { qty: r.qty + 1 })}>+</button>
                    </td>
                    <td style={{ width: 90 }}>
                      <input inputMode="decimal" value={r.price} onChange={(e) => setRow(r.key, { price: e.target.value })} />
                    </td>
                    <td>{money(D(r.price).times(r.qty).toFixed(2), 0)}</td>
                  </tr>
                ))}
                {yarnRows.map((y) => (
                  <tr key={y.itemId}>
                    <td>{yarnName.get(y.itemId)}</td>
                    <td>
                      <button onClick={() => setYarnRows(yarnRows.map((x) => (x === y ? { ...x, qty: x.qty - 1 } : x)).filter((x) => x.qty > 0))}>−</button> {y.qty}{' '}
                      <button onClick={() => setYarnRows(yarnRows.map((x) => (x === y ? { ...x, qty: x.qty + 1 } : x)))}>+</button>
                    </td>
                    <td>{money(yarnPrice(y.itemId), 0)}</td>
                    <td>{money(D(yarnPrice(y.itemId) ?? 0).times(y.qty).toFixed(2), 0)}</td>
                  </tr>
                ))}
                {rows.length === 0 && yarnRows.length === 0 && (
                  <tr>
                    <td className="muted">Toca un producto para agregarlo.</td>
                  </tr>
                )}
              </tbody>
            </table>

            <div className="grid2">
              <label className="field">
                <span className="label">Bolsa (una por venta)</span>
                <select value={bagId} onChange={(e) => pickBag(e.target.value)}>
                  <option value="">Sin bolsa</option>
                  {bags.map((b) => (
                    <option key={b.product_id} value={b.product_id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="label">Precio de la bolsa</span>
                <input inputMode="decimal" value={bagPrice} disabled={!bagId} onChange={(e) => setBagPrice(e.target.value)} />
              </label>
            </div>
            {bagId && (
              <label className="inline">
                <input type="checkbox" checked={bagDelivered} onChange={(e) => setBagDelivered(e.target.checked)} /> Entregué la bolsa (si no, se cobra pero no descuenta inventario)
              </label>
            )}

            <label className="field">
              <span className="label">Forma de pago</span>
              <select value={methodId} onChange={(e) => setMethodId(e.target.value)}>
                {methods.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            {method?.kind === 'cash' && (
              <label className="field">
                <span className="label">Recibido</span>
                <input inputMode="decimal" value={received} onChange={(e) => setReceived(e.target.value)} />
              </label>
            )}
            <ul className="kv">
              <li>
                <span>Total</span>
                <b style={{ fontSize: 22 }}>{money(total.toFixed(2))}</b>
              </li>
              {fee.gt(0) && (
                <li>
                  <span>Comisión estimada (no la paga el cliente)</span>
                  <b>{money(fee.toFixed(2))}</b>
                </li>
              )}
              {change !== null && (
                <li>
                  <span>Cambio</span>
                  <b>{change.gte(0) ? money(change.toFixed(2)) : `faltan ${money(change.abs().toFixed(2))}`}</b>
                </li>
              )}
            </ul>
            <input placeholder="Nota (opcional)" value={note} onChange={(e) => setNote(e.target.value)} />
            <ErrorBox message={error} />
            <div className="actions">
              <button onClick={reset}>Limpiar</button>
              <button className="primary" disabled={busy || total.lte(0)} onClick={charge}>
                {busy ? 'Guardando...' : `Cobrar ${money(total.toFixed(2))}`}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
