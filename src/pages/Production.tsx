import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import Decimal from 'decimal.js'
import { supabase } from '../supabase'
import { friendlyError, isNonNegativeNumber, isPositiveNumber, money, todayMX } from '../format'
import { ErrorBox, Field, Modal, OkBox } from '../ui'

interface ProductLite {
  id: string
  name: string
  kind: string
  is_active: boolean
  has_recipe: boolean | null
  cost_total_text: string | null
}
interface RunRow {
  id: string
  product_id: string
  qty: number
  run_date: string
  labor_hours: number
  labor_cost: number
  materials_cost: number
  total_cost: number
  unit_cost: number
  estimated_unit_cost: number
  note: string | null
  variant: string | null
}
interface TransferRow {
  id: string
  from_item_id: string
  to_item_id: string
  qty_madejas: number
  qty_base: number
  price_per_madeja: number
  from_cost_per_madeja: number | null
  transfer_date: string
  note: string | null
}
interface ItemLite {
  id: string
  name: string
  brand: string | null
  color: string | null
  color_code: string | null
  kind: string
  base_unit: string
  is_consumable: boolean
  content_qty: number | null
  content_unit: string | null
}

const itemName = (i: ItemLite) => [i.name, i.brand, i.color, i.color_code ? `cód. ${i.color_code}` : null].filter(Boolean).join(' · ')

interface RecipeLine {
  item_id: string
  per_piece: string
}
interface Part {
  item_id: string
  qty: string
}

function ProduceForm(props: { products: ProductLite[]; items: ItemLite[]; variants: string[]; onSaved: (msg: string) => void; onClose: () => void }) {
  const list = props.products.filter((p) => p.is_active && p.kind !== 'packaging')
  const [productId, setProductId] = useState('')
  const [qty, setQty] = useState('1')
  const [date, setDate] = useState(todayMX())
  const [note, setNote] = useState('')
  const [clientId] = useState(() => crypto.randomUUID())
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [variant, setVariant] = useState('')
  const [lines, setLines] = useState<RecipeLine[]>([])
  const [swaps, setSwaps] = useState<Record<string, Part[]>>({})
  const [extras, setExtras] = useState<Part[]>([])
  const prod = list.find((p) => p.id === productId)
  const itemById = useMemo(() => new Map(props.items.map((i) => [i.id, i])), [props.items])

  useEffect(() => {
    setSwaps({})
    setExtras([])
    setLines([])
    if (!productId) return
    let cancelled = false
    ;(async () => {
      const v = await supabase
        .from('product_versions')
        .select('id')
        .eq('product_id', productId)
        .lte('valid_from', date)
        .order('valid_from', { ascending: false })
        .order('version_no', { ascending: false })
        .limit(1)
      const vid = (v.data ?? [])[0]?.id
      if (!vid) return
      const c = await supabase.from('product_components').select('item_id, qty, waste_pct').eq('version_id', vid).not('item_id', 'is', null)
      if (cancelled || c.error) return
      setLines(
        (c.data ?? []).map((x: { item_id: string; qty: number; waste_pct: number }) => ({
          item_id: x.item_id,
          per_piece: new Decimal(x.qty).times(new Decimal(1).plus(x.waste_pct)).toString(),
        })),
      )
    })()
    return () => {
      cancelled = true
    }
  }, [productId, date])

  const colorLines = lines.filter((l) => itemById.get(l.item_id)?.kind === 'material')

  function startSwap(l: RecipeLine) {
    setSwaps((s) => ({ ...s, [l.item_id]: [{ item_id: l.item_id, qty: l.per_piece }] }))
  }
  function setPart(ref: string, idx: number, patch: Partial<Part>) {
    setSwaps((s) => ({ ...s, [ref]: s[ref].map((p, i) => (i === idx ? { ...p, ...patch } : p)) }))
  }
  function addPart(ref: string) {
    setSwaps((s) => ({ ...s, [ref]: [...s[ref], { item_id: ref, qty: '' }] }))
  }
  function removePart(ref: string, idx: number) {
    setSwaps((s) => ({ ...s, [ref]: s[ref].filter((_, i) => i !== idx) }))
  }
  function skipLine(ref: string) {
    setSwaps((s) => ({ ...s, [ref]: [] }))
  }
  function undoSwap(ref: string) {
    setSwaps((s) => {
      const n = { ...s }
      delete n[ref]
      return n
    })
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!productId) return setError('Elige el producto.')
    if (!isPositiveNumber(qty)) return setError('La cantidad debe ser mayor a 0.')
    const swapList: { item_id: string; parts: { item_id: string; qty: string }[] }[] = []
    for (const [ref, parts] of Object.entries(swaps)) {
      if (parts.some((p) => !isPositiveNumber(p.qty))) return setError('Las cantidades de cada color deben ser mayores a 0.')
      swapList.push({ item_id: ref, parts: parts.map((p) => ({ item_id: p.item_id, qty: p.qty })) })
    }
    if (extras.some((p) => !p.item_id || !isPositiveNumber(p.qty))) return setError('Completa material y cantidad en los materiales extra.')
    setBusy(true)
    setError('')
    const { error } = await supabase.rpc('produce_product', {
      p_product_id: productId,
      p_qty: qty,
      p_date: date,
      p_note: note.trim() || null,
      p_client_uuid: clientId,
      p_swap: swapList.length ? swapList : null,
      p_variant: variant.trim() || null,
      p_extra: extras.length ? extras.map((p) => ({ item_id: p.item_id, qty: p.qty })) : null,
    })
    setBusy(false)
    if (error) return setError(friendlyError(error.message))
    props.onSaved('Producción registrada: materiales descontados y producto terminado actualizado.')
  }

  let estimate = '—'
  try {
    if (prod?.cost_total_text && isPositiveNumber(qty)) estimate = money(new Decimal(prod.cost_total_text).times(qty).toFixed(2))
  } catch {
    estimate = '—'
  }

  return (
    <Modal title="Registrar producción" onClose={props.onClose}>
      <form onSubmit={submit}>
        <Field label="Producto">
          <select value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">Elegir...</option>
            {list.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.has_recipe}>
                {p.name}
                {p.has_recipe ? '' : ' (sin receta)'}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid2">
          <Field label="Cantidad de piezas">
            <input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
          </Field>
          <Field label="Fecha">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <p className="hint">
          Costo estimado de esta tanda: <b>{estimate}</b>. Se descuentan los materiales de la receta vigente. Si es un ramo o
          arreglo, usa las piezas terminadas que haya en existencia y teje desde cero las que falten.
        </p>
        {productId && lines.length > 0 && (
          <div className="panel-card" style={{ marginBottom: 12 }}>
            <b>Colores usados</b>
            <p className="muted small">
              Si usaste otros colores o una mezcla, cámbialos aquí (cantidades por pieza, a ojo está bien). Si no cambias nada, se usa la receta.
            </p>
            {colorLines.map((l) => {
              const ref = itemById.get(l.item_id)!
              const parts = swaps[l.item_id]
              const family = props.items.filter((i) => i.kind === 'material' && i.name === ref.name && (i.brand ?? '') === (ref.brand ?? ''))
              const others = props.items.filter((i) => i.kind === 'material' && !family.includes(i))
              let sum = new Decimal(0)
              if (parts) for (const p of parts) if (isPositiveNumber(p.qty)) sum = sum.plus(p.qty)
              return (
                <div key={l.item_id} style={{ marginBottom: 10 }}>
                  <div>
                    {itemName(ref)} · receta: <b>{l.per_piece}</b> {ref.base_unit} por pieza
                    {!parts && (
                      <>
                        {' '}
                        <button type="button" onClick={() => startSwap(l)}>
                          Cambiar colores
                        </button>{' '}
                        <button type="button" onClick={() => skipLine(l.item_id)}>
                          No lo usé
                        </button>
                      </>
                    )}
                  </div>
                  {parts && parts.length === 0 && (
                    <div className="row-actions" style={{ marginTop: 6 }}>
                      <span className="small">No se usa en esta pieza.</span>
                      <button type="button" onClick={() => undoSwap(l.item_id)}>
                        Volver a la receta
                      </button>
                    </div>
                  )}
                  {parts && parts.length > 0 && (
                    <>
                      {parts.map((p, idx) => (
                        <div key={idx} className="grid2" style={{ marginTop: 6 }}>
                          <select value={p.item_id} onChange={(e) => setPart(l.item_id, idx, { item_id: e.target.value })}>
                            <optgroup label="Mismo estambre / material">
                              {family.map((i) => (
                                <option key={i.id} value={i.id}>
                                  {itemName(i)}
                                </option>
                              ))}
                            </optgroup>
                            {others.length > 0 && (
                              <optgroup label="Otros materiales">
                                {others.map((i) => (
                                  <option key={i.id} value={i.id}>
                                    {itemName(i)}
                                  </option>
                                ))}
                              </optgroup>
                            )}
                          </select>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <input inputMode="decimal" value={p.qty} onChange={(e) => setPart(l.item_id, idx, { qty: e.target.value })} placeholder={`${ref.base_unit} por pieza`} />
                            {parts.length > 1 && (
                              <button type="button" onClick={() => removePart(l.item_id, idx)}>
                                Quitar
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                      <div className="row-actions" style={{ marginTop: 6 }}>
                        <button type="button" onClick={() => addPart(l.item_id)}>
                          + Otro color
                        </button>
                        <button type="button" onClick={() => undoSwap(l.item_id)}>
                          Volver a la receta
                        </button>
                        <span className={sum.eq(l.per_piece) ? 'muted small' : 'small'}>
                          Total: {sum.toString()} {ref.base_unit} (receta {l.per_piece})
                        </span>
                      </div>
                    </>
                  )}
                </div>
              )
            })}
            <div style={{ marginTop: 10 }}>
              <b className="small">Materiales extra</b> <span className="muted small">(no están en la receta, cantidad por pieza)</span>
              {extras.map((p, idx) => (
                <div key={idx} className="grid2" style={{ marginTop: 6 }}>
                  <select value={p.item_id} onChange={(e) => setExtras((x) => x.map((q, i) => (i === idx ? { ...q, item_id: e.target.value } : q)))}>
                    <option value="">Elegir material...</option>
                    {props.items
                      .filter((i) => i.kind === 'material')
                      .map((i) => (
                        <option key={i.id} value={i.id}>
                          {itemName(i)}
                        </option>
                      ))}
                  </select>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input inputMode="decimal" value={p.qty} onChange={(e) => setExtras((x) => x.map((q, i) => (i === idx ? { ...q, qty: e.target.value } : q)))} placeholder="cantidad por pieza" />
                    <button type="button" onClick={() => setExtras((x) => x.filter((_, i) => i !== idx))}>
                      Quitar
                    </button>
                  </div>
                </div>
              ))}
              <div className="row-actions" style={{ marginTop: 6 }}>
                <button type="button" onClick={() => setExtras((x) => [...x, { item_id: '', qty: '' }])}>
                  + Agregar material extra
                </button>
              </div>
            </div>
          </div>
        )}
        <Field label="Variante (opcional, ej. siamés, negro, manchas)">
          <input list="run-variants" value={variant} onChange={(e) => setVariant(e.target.value)} />
          <datalist id="run-variants">
            {props.variants.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </Field>
        <Field label="Nota (opcional)">
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <ErrorBox message={error} />
        <div className="actions">
          <button type="button" onClick={props.onClose}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Guardando...' : 'Registrar producción'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function TransferForm(props: { items: ItemLite[]; onSaved: (msg: string) => void; onClose: () => void }) {
  const sale = props.items.filter((i) => i.kind === 'resale')
  const prod = props.items.filter((i) => i.kind !== 'resale' && i.is_consumable)
  const [fromId, setFromId] = useState('')
  const [toId, setToId] = useState('')
  const [qty, setQty] = useState('1')
  const [date, setDate] = useState(todayMX())
  const [price, setPrice] = useState('')
  const [note, setNote] = useState('')
  const [clientId] = useState(() => crypto.randomUUID())
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const from = sale.find((i) => i.id === fromId)
  const targets = prod.filter((i) => !from || i.base_unit === from.content_unit)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!fromId || !toId) return setError('Elige el estambre de venta y el material de producción.')
    if (!isPositiveNumber(qty)) return setError('La cantidad de madejas debe ser mayor a 0.')
    if (price.trim() !== '' && !isNonNegativeNumber(price)) return setError('El precio no es válido.')
    setBusy(true)
    setError('')
    const { error } = await supabase.rpc('transfer_yarn_to_production', {
      p_from_item: fromId,
      p_to_item: toId,
      p_qty_madejas: qty,
      p_date: date,
      p_price_per_madeja: price.trim() === '' ? null : price,
      p_note: note.trim() || null,
      p_client_uuid: clientId,
    })
    setBusy(false)
    if (error) return setError(friendlyError(error.message))
    props.onSaved('Estambre pasado a producción. No cuenta como venta.')
  }

  return (
    <Modal title="Pasar estambre a producción" onClose={props.onClose}>
      <form onSubmit={submit}>
        <Field label="Estambre de venta (sale de aquí)">
          <select
            value={fromId}
            onChange={(e) => {
              setFromId(e.target.value)
              setToId('')
            }}
          >
            <option value="">Elegir...</option>
            {sale.map((i) => (
              <option key={i.id} value={i.id}>
                {itemName(i)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Material de producción (entra aquí, en gramos)" hint="Si no aparece, créalo en Insumos como Material en gramos.">
          <select value={toId} onChange={(e) => setToId(e.target.value)}>
            <option value="">Elegir...</option>
            {targets.map((i) => (
              <option key={i.id} value={i.id}>
                {itemName(i)} ({i.base_unit})
              </option>
            ))}
          </select>
        </Field>
        <div className="grid3">
          <Field label="Madejas">
            <input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
          </Field>
          <Field label="Precio por madeja" hint="Vacío = precio interno del grupo ($60)">
            <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
          </Field>
          <Field label="Fecha">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Nota (opcional)">
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <ErrorBox message={error} />
        <div className="actions">
          <button type="button" onClick={props.onClose}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Guardando...' : 'Pasar a producción'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function InitialStock(props: { products: ProductLite[]; stock: Map<string, number>; onSaved: () => void; onClose: () => void }) {
  const list = props.products.filter((p) => p.is_active && p.kind !== 'packaging')
  const [productId, setProductId] = useState('')
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const current = props.stock.get(productId) ?? 0

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!productId) return setError('Elige el producto.')
    let delta: Decimal
    try {
      if (value.trim() === '') throw new Error('x')
      delta = new Decimal(value).minus(current)
    } catch {
      return setError('Escribe cuántas piezas tienes hechas.')
    }
    if (delta.isZero()) return setError('Ya hay esa cantidad en el sistema.')
    setBusy(true)
    const { error } = await supabase.rpc('adjust_product_stock', {
      p_product_id: productId,
      p_delta: delta.toString(),
      p_reason: 'Existencia inicial (ya estaban hechas)',
    })
    setBusy(false)
    if (error) return setError(friendlyError(error.message))
    props.onSaved()
  }

  return (
    <Modal title="Ya tengo piezas hechas" onClose={props.onClose}>
      <form onSubmit={submit}>
        <p className="muted small">
          Para producto que ya estaba terminado antes de usar el sistema. No descuenta materiales ni mano de obra. Se valúa al costo de la receta actual.
        </p>
        <Field label="Producto">
          <select value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">Elegir...</option>
            {list.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        {productId && <p className="small">En el sistema ahora: <b>{current}</b> piezas</p>}
        <Field label="Piezas que tengo hechas en total">
          <input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
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

function AdjustProduct(props: { product: ProductLite; stock: number; onSaved: () => void; onClose: () => void }) {
  const [value, setValue] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    let delta: Decimal
    try {
      if (value.trim() === '') throw new Error('x')
      delta = new Decimal(value).minus(props.stock)
    } catch {
      return setError('Escribe cuántas piezas hay realmente.')
    }
    if (delta.isZero()) return setError('No hay diferencia.')
    if (!reason.trim()) return setError('Escribe el motivo (conteo, regalo, defecto...).')
    setBusy(true)
    const { error } = await supabase.rpc('adjust_product_stock', {
      p_product_id: props.product.id,
      p_delta: delta.toString(),
      p_reason: reason.trim(),
    })
    setBusy(false)
    if (error) return setError(friendlyError(error.message))
    props.onSaved()
  }

  return (
    <Modal title={`Ajustar: ${props.product.name}`} onClose={props.onClose}>
      <p>
        Existencia en el sistema: <b>{props.stock}</b>
      </p>
      <form onSubmit={submit}>
        <Field label="Piezas que hay realmente">
          <input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <Field label="Motivo">
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <ErrorBox message={error} />
        <div className="actions">
          <button type="button" onClick={props.onClose}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Guardando...' : 'Guardar ajuste'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export default function Production() {
  const [products, setProducts] = useState<ProductLite[]>([])
  const [stock, setStock] = useState<Map<string, number>>(new Map())
  const [runs, setRuns] = useState<RunRow[]>([])
  const [transfers, setTransfers] = useState<TransferRow[]>([])
  const [items, setItems] = useState<ItemLite[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')
  const [dlg, setDlg] = useState<'' | 'produce' | 'transfer' | 'initial'>('')
  const [adjusting, setAdjusting] = useState<ProductLite | null>(null)

  const load = useCallback(async () => {
    setError('')
    const [p, s, r, t, i] = await Promise.all([
      supabase.from('v_product_overview').select('id, name, kind, is_active, has_recipe, cost_total_text').order('name'),
      supabase.from('v_product_stock').select('product_id, stock_qty'),
      supabase
        .from('production_runs')
        .select('id, product_id, qty, run_date, labor_hours, labor_cost, materials_cost, total_cost, unit_cost, estimated_unit_cost, note, variant')
        .order('run_date', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(50),
      supabase
        .from('yarn_transfers')
        .select('id, from_item_id, to_item_id, qty_madejas, qty_base, price_per_madeja, from_cost_per_madeja, transfer_date, note')
        .order('transfer_date', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(30),
      supabase.from('items').select('id, name, brand, color, color_code, kind, base_unit, is_consumable, content_qty, content_unit').eq('is_active', true).order('name'),
    ])
    if (p.error) setError(friendlyError(p.error.message))
    else setProducts((p.data ?? []) as ProductLite[])
    if (!s.error) setStock(new Map((s.data ?? []).map((x: { product_id: string; stock_qty: number }) => [x.product_id, Number(x.stock_qty)])))
    if (!r.error) setRuns((r.data ?? []) as RunRow[])
    if (!t.error) setTransfers((t.data ?? []) as TransferRow[])
    if (!i.error) setItems((i.data ?? []) as ItemLite[])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const pname = useMemo(() => new Map(products.map((p) => [p.id, p.name])), [products])
  const iname = useMemo(() => new Map(items.map((i) => [i.id, itemName(i)])), [items])
  const withStock = products.filter((p) => p.kind !== 'packaging' && (stock.get(p.id) ?? 0) !== 0)

  function done(msg: string) {
    setDlg('')
    setOk(msg)
    load()
  }

  return (
    <div>
      <div className="section-head">
        <h2>Producción</h2>
        <button onClick={() => setDlg('initial')}>Ya tengo piezas hechas</button>
        <button onClick={() => setDlg('transfer')}>Pasar estambre a producción</button>
        <button className="primary" onClick={() => setDlg('produce')}>
          + Registrar producción
        </button>
      </div>
      <ErrorBox message={error} />
      <OkBox message={ok} />
      {loading ? (
        <p className="muted">Cargando...</p>
      ) : (
        <>
          <h3>Producto terminado en existencia</h3>
          {withStock.length === 0 ? (
            <p className="muted">Aún no hay producto terminado.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Producto</th>
                  <th>Piezas</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {withStock.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td>{stock.get(p.id)}</td>
                    <td>
                      <button onClick={() => setAdjusting(p)}>Ajustar</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>Últimas tandas (costo real vs. estimado)</h3>
          {runs.length === 0 ? (
            <p className="muted">Sin tandas todavía.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Producto</th>
                    <th>Piezas</th>
                    <th>Materiales</th>
                    <th>Mano de obra</th>
                    <th>Costo real c/u</th>
                    <th>Estimado c/u</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <td>{r.run_date}</td>
                      <td>
                        {pname.get(r.product_id) ?? '—'}
                        {r.variant && <span className="pill"> {r.variant}</span>}
                        {r.note && <span className="muted small"> · {r.note}</span>}
                      </td>
                      <td>{r.qty}</td>
                      <td>{money(r.materials_cost)}</td>
                      <td>
                        {money(r.labor_cost)} ({r.labor_hours} h)
                      </td>
                      <td>{money(r.unit_cost)}</td>
                      <td>{money(r.estimated_unit_cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h3>Estambre pasado a producción</h3>
          {transfers.length === 0 ? (
            <p className="muted">Ninguno todavía.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>De</th>
                    <th>A</th>
                    <th>Madejas</th>
                    <th>Precio interno</th>
                    <th>Costo de compra</th>
                  </tr>
                </thead>
                <tbody>
                  {transfers.map((t) => (
                    <tr key={t.id}>
                      <td>{t.transfer_date}</td>
                      <td>{iname.get(t.from_item_id) ?? '—'}</td>
                      <td>
                        {iname.get(t.to_item_id) ?? '—'} (+{t.qty_base})
                      </td>
                      <td>{t.qty_madejas}</td>
                      <td>{money(t.price_per_madeja)}</td>
                      <td>{money(t.from_cost_per_madeja)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {dlg === 'produce' && <ProduceForm products={products} items={items} variants={Array.from(new Set(runs.map((r) => r.variant).filter((v): v is string => !!v)))} onSaved={done} onClose={() => setDlg('')} />}
      {dlg === 'initial' && <InitialStock products={products} stock={stock} onSaved={() => done('Existencia guardada.')} onClose={() => setDlg('')} />}
      {dlg === 'transfer' && <TransferForm items={items} onSaved={done} onClose={() => setDlg('')} />}
      {adjusting && (
        <AdjustProduct
          product={adjusting}
          stock={stock.get(adjusting.id) ?? 0}
          onSaved={() => {
            setAdjusting(null)
            setOk('Ajuste guardado.')
            load()
          }}
          onClose={() => setAdjusting(null)}
        />
      )}
    </div>
  )
}
