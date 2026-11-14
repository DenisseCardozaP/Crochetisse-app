import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import Decimal from 'decimal.js'
import { supabase } from '../supabase'
import { friendlyError, isNonNegativeNumber, isPositiveNumber, money, todayMX } from '../format'
import { ErrorBox, Field, Modal, OkBox } from '../ui'

interface ItemLite {
  id: string
  name: string
  brand: string | null
  color: string | null
  purchase_unit: string
  base_unit: string
  units_per_purchase: number
}
interface Supplier {
  id: string
  name: string
}
interface PurchaseRow {
  id: string
  purchase_date: string
  supplier_id: string | null
  shipping: number
  items_total: number
  total_paid: number
  note: string | null
}
interface LineRow {
  id: string
  item_id: string
  qty_purchase: number
  qty_base: number
  line_price: number
  shipping_alloc: number
  landed_total: number
  unit_cost_base: number
}
interface Line {
  key: string
  itemId: string
  qty: string
  price: string
  mode: 'keep' | 'new' // qué hacer con el precio de referencia si esta compra salió distinta
}

const label = (i: ItemLite): string => [i.name, i.brand, i.color].filter(Boolean).join(' · ') + ` (${i.purchase_unit})`

function dec(s: string): Decimal {
  try {
    return new Decimal(s === '' ? '0' : s)
  } catch {
    return new Decimal(0)
  }
}

function NewPurchase(props: { items: ItemLite[]; suppliers: Supplier[]; onSaved: () => void; onClose: () => void }) {
  const [supplierId, setSupplierId] = useState('')
  const [date, setDate] = useState(todayMX())
  const [shipping, setShipping] = useState('0')
  const [note, setNote] = useState('')
  const [lines, setLines] = useState<Line[]>([{ key: crypto.randomUUID(), itemId: '', qty: '', price: '', mode: 'keep' as const }])
  const [clientId] = useState(() => crypto.randomUUID())
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const byId = useMemo(() => new Map(props.items.map((i) => [i.id, i])), [props.items])
  // Precio de referencia actual de cada material (por unidad base): el que usan tus costos
  const [current, setCurrent] = useState<Map<string, Decimal>>(new Map())
  useEffect(() => {
    supabase
      .from('v_item_cost_current')
      .select('item_id, unit_cost_base')
      .then(({ data }) => setCurrent(new Map((data ?? []).map((r: { item_id: string; unit_cost_base: string | number }) => [r.item_id, new Decimal(String(r.unit_cost_base))]))))
  }, [])
  const itemsTotal = lines.reduce((a, l) => a.plus(dec(l.price)), new Decimal(0))
  const ship = dec(shipping)
  const grand = itemsTotal.plus(ship)

  function setLine(key: string, patch: Partial<Line>) {
    setLines(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }

  // Vista previa: costo por unidad base con el envío repartido por valor (el oficial lo calcula la base de datos)
  function preview(l: Line): string {
    const it = byId.get(l.itemId)
    if (!it || !isPositiveNumber(l.qty) || !isNonNegativeNumber(l.price)) return '—'
    const price = dec(l.price)
    const share = itemsTotal.gt(0) ? ship.times(price).div(itemsTotal) : new Decimal(0)
    const base = dec(l.qty).times(it.units_per_purchase)
    return `${money(price.plus(share).div(base).toFixed(4), 4)} por ${it.base_unit}`
  }

  // Costo por unidad base de este renglón (con envío repartido) y cómo se compara con el precio actual
  function compare(l: Line): { now: Decimal; cur: Decimal | null; differs: boolean } | null {
    const it = byId.get(l.itemId)
    if (!it || !isPositiveNumber(l.qty) || !isNonNegativeNumber(l.price)) return null
    const price = dec(l.price)
    const share = itemsTotal.gt(0) ? ship.times(price).div(itemsTotal) : new Decimal(0)
    const now = price.plus(share).div(dec(l.qty).times(it.units_per_purchase))
    const cur = current.get(l.itemId) ?? null
    const differs = cur !== null && cur.gt(0) && now.minus(cur).abs().div(cur).gt(0.0005)
    return { now, cur, differs }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!isNonNegativeNumber(shipping)) return setError('El envío debe ser un número (0 si no hubo).')
    for (const l of lines) {
      if (!l.itemId) return setError('Hay un renglón sin material elegido.')
      if (!isPositiveNumber(l.qty)) return setError('Las cantidades deben ser mayores a 0.')
      if (!isNonNegativeNumber(l.price)) return setError('Escribe lo que pagaste por cada renglón.')
    }
    const ids = lines.map((l) => l.itemId)
    if (new Set(ids).size !== ids.length) return setError('Hay un material repetido: junta las cantidades en un renglón.')
    setBusy(true)
    setError('')
    const { error } = await supabase.rpc('register_purchase', {
      p_supplier_id: supplierId || null,
      p_purchase_date: date,
      p_shipping: shipping,
      p_note: note.trim() || null,
      p_client_uuid: clientId,
      p_lines: lines.map((l) => ({ item_id: l.itemId, qty: l.qty, line_price: l.price, price_mode: compare(l)?.differs ? l.mode : 'keep' })),
    })
    setBusy(false)
    if (error) return setError(friendlyError(error.message))
    props.onSaved()
  }

  return (
    <Modal title="Registrar compra" onClose={props.onClose}>
      <form onSubmit={submit}>
        <div className="grid3">
          <Field label="Fecha">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Proveedor (opcional)">
            <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">—</option>
              {props.suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Envío total" hint="Se reparte entre los renglones según su valor.">
            <input inputMode="decimal" value={shipping} onChange={(e) => setShipping(e.target.value)} />
          </Field>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Material</th>
              <th>Cantidad comprada</th>
              <th>Total pagado por el renglón</th>
              <th>Costo resultante</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const it = byId.get(l.itemId)
              const cmp = compare(l)
              return (
                <Fragment key={l.key}>
                <tr>
                  <td>
                    <select value={l.itemId} onChange={(e) => setLine(l.key, { itemId: e.target.value })}>
                      <option value="">Elegir...</option>
                      {props.items.map((i) => (
                        <option key={i.id} value={i.id}>
                          {label(i)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input inputMode="decimal" value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} />
                    {it && (
                      <span className="hint">
                        en {it.purchase_unit}s (1 = {it.units_per_purchase} {it.base_unit})
                      </span>
                    )}
                  </td>
                  <td>
                    <input inputMode="decimal" value={l.price} onChange={(e) => setLine(l.key, { price: e.target.value })} />
                  </td>
                  <td>{preview(l)}</td>
                  <td>
                    {lines.length > 1 && (
                      <button type="button" onClick={() => setLines(lines.filter((x) => x.key !== l.key))}>
                        Quitar
                      </button>
                    )}
                  </td>
                </tr>
                {it && cmp && cmp.cur === null && (
                  <tr>
                    <td colSpan={5} className="hint">
                      Este material todavía no tiene precio: esta compra lo establece ({money(cmp.now.times(it.units_per_purchase).toFixed(2))} por {it.purchase_unit}).
                    </td>
                  </tr>
                )}
                {it && cmp && cmp.differs && cmp.cur && (
                  <tr>
                    <td colSpan={5}>
                      <div className="alert-banner" style={{ marginTop: 0 }}>
                        Tu precio actual: <b>{money(cmp.cur.times(it.units_per_purchase).toFixed(2))}</b> por {it.purchase_unit} · esta compra:{' '}
                        <b>{money(cmp.now.times(it.units_per_purchase).toFixed(2))}</b> ({cmp.now.gt(cmp.cur) ? '+' : ''}
                        {cmp.now.minus(cmp.cur).div(cmp.cur).times(100).toFixed(1)}%).
                        <div style={{ marginTop: 6 }}>
                          <select value={l.mode} onChange={(e) => setLine(l.key, { mode: e.target.value as 'keep' | 'new' })}>
                            <option value="keep">Mantener mi precio actual (error, oferta o caso aislado)</option>
                            <option value="new">Usar el precio de esta compra (cambio fijo de precio)</option>
                          </select>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
        <div className="actions left">
          <button type="button" onClick={() => setLines([...lines, { key: crypto.randomUUID(), itemId: '', qty: '', price: '', mode: 'keep' as const }])}>
            + Otro material
          </button>
        </div>
        <ul className="kv">
          <li>
            <span>Materiales</span>
            <b>{money(itemsTotal.toFixed(2))}</b>
          </li>
          <li>
            <span>Envío</span>
            <b>{money(ship.toFixed(2))}</b>
          </li>
          <li>
            <span>Total de la compra</span>
            <b>{money(grand.toFixed(2))}</b>
          </li>
        </ul>
        <p className="hint">
          Tú decides si el precio de un material cambia: si esta compra sale distinta a tu precio actual, te preguntamos por
          renglón. La compra y tu existencia siempre quedan con lo que realmente pagaste; lo que eliges es si tus costos y
          precios de venta se mueven con ella.
        </p>
        <Field label="Nota (opcional)">
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <ErrorBox message={error} />
        <div className="actions">
          <button type="button" onClick={props.onClose}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Guardando...' : 'Guardar compra'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function PurchaseDetail(props: {
  purchase: PurchaseRow
  voided: boolean
  items: ItemLite[]
  isOwner: boolean
  onChanged: () => void
  onClose: () => void
}) {
  const [lines, setLines] = useState<LineRow[]>([])
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const byId = useMemo(() => new Map(props.items.map((i) => [i.id, i])), [props.items])

  useEffect(() => {
    supabase
      .from('purchase_lines')
      .select('id, item_id, qty_purchase, qty_base, line_price, shipping_alloc, landed_total, unit_cost_base')
      .eq('purchase_id', props.purchase.id)
      .then(({ data, error }) => {
        if (error) setError(friendlyError(error.message))
        else setLines((data ?? []) as LineRow[])
      })
  }, [props.purchase.id])

  async function voidIt() {
    if (!window.confirm('¿Anular esta compra? La existencia se revierte. El costo promedio se queda hasta la siguiente compra.')) return
    setBusy(true)
    const { error } = await supabase.rpc('void_purchase', { p_purchase_id: props.purchase.id, p_reason: reason.trim() || null })
    setBusy(false)
    if (error) return setError(friendlyError(error.message))
    props.onChanged()
  }

  return (
    <Modal title={`Compra del ${props.purchase.purchase_date}`} onClose={props.onClose}>
      <ErrorBox message={error} />
      {props.voided && <ErrorBox message="Esta compra está anulada." />}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Material</th>
              <th>Cantidad</th>
              <th>Pagado</th>
              <th>Envío</th>
              <th>Costo por unidad base</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const it = byId.get(l.item_id)
              return (
                <tr key={l.id}>
                  <td>{it ? label(it) : l.item_id}</td>
                  <td>
                    {l.qty_purchase} ({l.qty_base} {it?.base_unit})
                  </td>
                  <td>{money(l.line_price)}</td>
                  <td>{money(l.shipping_alloc)}</td>
                  <td>{money(l.unit_cost_base, 4)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <ul className="kv">
        <li>
          <span>Total pagado</span>
          <b>{money(props.purchase.total_paid)}</b>
        </li>
        {props.purchase.note && (
          <li>
            <span>Nota</span>
            <b>{props.purchase.note}</b>
          </li>
        )}
      </ul>
      {!props.voided && (
        <>
          <Field label="Motivo para anular (opcional)">
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="actions left">
            <button disabled={busy} onClick={voidIt}>
              Anular compra
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}

export default function Purchases({ isOwner }: { isOwner: boolean }) {
  const [rows, setRows] = useState<PurchaseRow[]>([])
  const [voids, setVoids] = useState<Set<string>>(new Set())
  const [items, setItems] = useState<ItemLite[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')
  const [creating, setCreating] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError('')
    const [p, v, i, s] = await Promise.all([
      supabase
        .from('purchases')
        .select('id, purchase_date, supplier_id, shipping, items_total, total_paid, note')
        .order('purchase_date', { ascending: false })
        .order('created_at', { ascending: false }),
      supabase.from('purchase_voids').select('purchase_id'),
      supabase
        .from('items')
        .select('id, name, brand, color, purchase_unit, base_unit, units_per_purchase')
        .eq('is_active', true)
        .order('name'),
      supabase.from('suppliers').select('id, name').eq('is_active', true).order('name'),
    ])
    if (p.error) setError(friendlyError(p.error.message))
    else setRows((p.data ?? []) as PurchaseRow[])
    if (!v.error) setVoids(new Set((v.data ?? []).map((x: { purchase_id: string }) => x.purchase_id)))
    if (!i.error) setItems((i.data ?? []) as ItemLite[])
    if (!s.error) setSuppliers((s.data ?? []) as Supplier[])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const supplierName = (id: string | null) => suppliers.find((s) => s.id === id)?.name ?? '—'
  const open = rows.find((r) => r.id === openId) ?? null

  return (
    <div>
      <div className="section-head">
        <h2>Compras</h2>
        <button className="primary" onClick={() => setCreating(true)}>
          + Registrar compra
        </button>
      </div>
      <ErrorBox message={error} />
      <OkBox message={ok} />
      {loading ? (
        <p className="muted">Cargando...</p>
      ) : rows.length === 0 ? (
        <p className="muted">Aún no hay compras registradas.</p>
      ) : (
        <div className="table-wrap">
          <table className="table clickable">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Proveedor</th>
                <th>Materiales</th>
                <th>Envío</th>
                <th>Total</th>
                <th>Nota</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={voids.has(r.id) ? 'inactive' : ''} onClick={() => setOpenId(r.id)}>
                  <td>
                    {r.purchase_date}
                    {voids.has(r.id) && <span className="pill">anulada</span>}
                  </td>
                  <td>{supplierName(r.supplier_id)}</td>
                  <td>{money(r.items_total)}</td>
                  <td>{money(r.shipping)}</td>
                  <td>{money(r.total_paid)}</td>
                  <td>{r.note ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && (
        <NewPurchase
          items={items}
          suppliers={suppliers}
          onSaved={() => {
            setCreating(false)
            setOk('Compra registrada: existencia y costos actualizados.')
            load()
          }}
          onClose={() => setCreating(false)}
        />
      )}
      {open && (
        <PurchaseDetail
          purchase={open}
          voided={voids.has(open.id)}
          items={items}
          isOwner={isOwner}
          onChanged={() => {
            setOpenId(null)
            setOk('Compra anulada.')
            load()
          }}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  )
}
