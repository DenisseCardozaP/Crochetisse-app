import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { supabase } from '../supabase'
import {
  displayDate,
  fractionToPct,
  friendlyError,
  isNonNegativeNumber,
  isPositiveNumber,
  money,
  pct,
  pctToFraction,
  todayMX,
} from '../format'
import { ErrorBox, Field, Modal, OkBox } from '../ui'

type Kind = 'amigurumi' | 'assembly' | 'bundle' | 'packaging'

const KIND_LABEL: Record<Kind, string> = {
  amigurumi: 'Amigurumi',
  assembly: 'Ensamble (ramo, arreglo)',
  bundle: 'Combo',
  packaging: 'Empaque',
}

interface Overview {
  id: string
  code: string | null
  name: string
  kind: Kind
  description: string | null
  tax_rate_id: string | null
  pricing_method_override: 'markup' | 'margin' | null
  profit_pct_override: number | null
  default_packaging_id: string | null
  default_packaging_name: string | null
  is_active: boolean
  current_version_no: number | null
  current_labor_hours: number | null
  cost_total_text: string | null
  cost_complete: boolean | null
  has_recipe: boolean | null
  suggested_price: number | null
  current_price: number | null
  price_valid_from: string | null
}

interface TaxRate {
  id: string
  code: string
  name: string
}

interface CostLine {
  type: 'item' | 'product'
  id: string
  name: string
  unit: string
  qty: number
  waste_pct: number
  unit_cost: number | null
  cost: number | null
}

interface Cost {
  has_recipe: boolean
  complete: boolean
  version_no?: number
  version_id?: string
  labor_hours?: number
  labor_rate?: number
  labor: number
  materials: number
  components: number
  total: number
  lines: CostLine[]
  missing: string[]
}

interface Suggestion {
  cost: Cost
  complete: boolean
  method: 'markup' | 'margin'
  profit_pct: number
  iva_rate: number
  card_commission_factor: number
  isr_factor: number
  price_before_rounding: number
  rounding_mode: string
  rounding_step: number
  suggested_price: number
  suggested_ex_tax: number
  suggested_iva: number
  est_card_commission: number
}

interface PriceRow {
  id: string
  valid_from: string
  price_incl_tax: number
  suggested_price: number | null
  note: string | null
}

interface VersionRow {
  id: string
  version_no: number
  valid_from: string
  labor_hours: number
  notes: string | null
}

interface ItemLite {
  id: string
  name: string
  brand: string | null
  color: string | null
  base_unit: string
}

interface RecipeLine {
  key: string
  type: 'item' | 'product'
  id: string
  qty: string
  waste: string // porcentaje que escribe la persona
}

const itemLabel = (i: ItemLite): string =>
  [i.name, i.brand, i.color].filter(Boolean).join(' · ') + ` (${i.base_unit})`

// ---------------------------------------------------------------- datos del producto
function ProductForm(props: {
  product: Overview | null
  all: Overview[]
  taxRates: TaxRate[]
  onSaved: () => void
  onClose: () => void
}) {
  const p = props.product
  const [name, setName] = useState(p?.name ?? '')
  const [code, setCode] = useState(p?.code ?? '')
  const [kind, setKind] = useState<Kind>(p?.kind ?? 'amigurumi')
  const [description, setDescription] = useState(p?.description ?? '')
  const [taxId, setTaxId] = useState(p?.tax_rate_id ?? '')
  const [packagingId, setPackagingId] = useState(p?.default_packaging_id ?? '')
  const [method, setMethod] = useState<string>(p?.pricing_method_override ?? '')
  const [profit, setProfit] = useState(p?.profit_pct_override != null ? fractionToPct(p.profit_pct_override) : '')
  const [active, setActive] = useState(p?.is_active ?? true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const packagings = props.all.filter((x) => x.kind === 'packaging' && x.is_active)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return setError('Escribe el nombre del producto.')
    if (method && !isNonNegativeNumber(profit)) return setError('Escribe el porcentaje de ganancia propio (o deja el método vacío).')
    if (method === 'margin' && Number(profit) >= 100) return setError('Con margen, la ganancia debe ser menor a 100%.')
    setBusy(true)
    setError('')
    const row = {
      name: name.trim(),
      code: code.trim() || null,
      kind,
      description: description.trim() || null,
      tax_rate_id: taxId || null,
      default_packaging_id: kind === 'packaging' ? null : packagingId || null,
      pricing_method_override: method || null,
      profit_pct_override: method ? pctToFraction(profit) : null,
      is_active: active,
    }
    const res = p
      ? await supabase.from('products').update(row).eq('id', p.id)
      : await supabase.from('products').insert(row)
    setBusy(false)
    if (res.error) {
      if (res.error.message.includes('products_name_unique')) return setError('Ya existe un producto con ese nombre.')
      return setError(friendlyError(res.error.message))
    }
    props.onSaved()
  }

  return (
    <Modal title={p ? 'Editar producto' : 'Nuevo producto'} onClose={props.onClose}>
      <form onSubmit={submit}>
        <div className="grid2">
          <Field label="Nombre">
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Código (opcional)">
            <input value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
        </div>
        <div className="grid2">
          <Field
            label="Tipo"
            hint="Un empaque es la bolsa/etiqueta que se cobra aparte; se arma con insumos como cualquier receta."
          >
            <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="IVA">
            <select value={taxId} onChange={(e) => setTaxId(e.target.value)}>
              <option value="">IVA predeterminado (hoy 0%)</option>
              {props.taxRates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {kind !== 'packaging' && (
          <Field label="Empaque predeterminado (opcional)">
            <select value={packagingId} onChange={(e) => setPackagingId(e.target.value)}>
              <option value="">Ninguno</option>
              {packagings.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Descripción (opcional)">
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <h3>Ganancia propia (opcional)</h3>
        <p className="hint">Déjala vacía para usar la ganancia general de Configuración.</p>
        <div className="grid2">
          <Field label="Método">
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="">Usar el general</option>
              <option value="margin">Margen (sobre el precio)</option>
              <option value="markup">Recargo (sobre el costo)</option>
            </select>
          </Field>
          <Field label="Porcentaje (%)">
            <input inputMode="decimal" value={profit} disabled={!method} onChange={(e) => setProfit(e.target.value)} />
          </Field>
        </div>
        {p && (
          <label className="inline">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Activo
          </label>
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
    </Modal>
  )
}

// ---------------------------------------------------------------- editor de receta
function RecipeEditor(props: {
  product: Overview
  cost: Cost | null
  items: ItemLite[]
  products: Overview[]
  onSaved: () => void
  onClose: () => void
}) {
  const [hours, setHours] = useState(props.cost?.labor_hours != null ? String(props.cost.labor_hours) : '')
  const [notes, setNotes] = useState('')
  const [validFrom, setValidFrom] = useState(todayMX())
  const [lines, setLines] = useState<RecipeLine[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    async function load() {
      const versionId = props.cost?.version_id
      if (!versionId) {
        setLoaded(true)
        return
      }
      const { data, error } = await supabase
        .from('product_components')
        .select('id, item_id, component_product_id, qty, waste_pct')
        .eq('version_id', versionId)
      if (!alive) return
      if (error) setError(friendlyError(error.message))
      else
        setLines(
          (data ?? []).map((c: any) => ({
            key: c.id,
            type: c.item_id ? 'item' : 'product',
            id: c.item_id ?? c.component_product_id,
            qty: String(c.qty),
            waste: fractionToPct(c.waste_pct),
          })),
        )
      setLoaded(true)
    }
    load()
    return () => {
      alive = false
    }
  }, [props.cost?.version_id])

  const options = useMemo(() => {
    const prods = props.products.filter((x) => x.id !== props.product.id && x.kind !== 'packaging' && x.is_active)
    return { prods }
  }, [props.products, props.product.id])

  function addLine(type: 'item' | 'product') {
    setLines([...lines, { key: crypto.randomUUID(), type, id: '', qty: '', waste: '0' }])
  }
  function setLine(key: string, patch: Partial<RecipeLine>) {
    setLines(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!isNonNegativeNumber(hours)) return setError('Escribe las horas de trabajo (puede ser 0).')
    if (lines.length === 0) return setError('Agrega al menos un material o producto a la receta.')
    for (const l of lines) {
      if (!l.id) return setError('Hay un renglón sin material o producto elegido.')
      if (!isPositiveNumber(l.qty)) return setError('Todas las cantidades deben ser mayores a 0.')
      if (!isNonNegativeNumber(l.waste) || Number(l.waste) >= 100) return setError('La merma debe estar entre 0 y 99%.')
    }
    const ids = lines.map((l) => l.type + l.id)
    if (new Set(ids).size !== ids.length) return setError('Hay un material repetido. Junta las cantidades en un solo renglón.')
    setBusy(true)
    setError('')
    const { error } = await supabase.rpc('save_product_version', {
      p_product_id: props.product.id,
      p_labor_hours: hours,
      p_notes: notes.trim() || null,
      p_valid_from: validFrom,
      p_components: lines.map((l) => ({
        [l.type === 'item' ? 'item_id' : 'component_product_id']: l.id,
        qty: l.qty,
        waste_pct: pctToFraction(l.waste),
      })),
    })
    setBusy(false)
    if (error) return setError(friendlyError(error.message))
    props.onSaved()
  }

  return (
    <Modal title={`Receta de ${props.product.name}`} onClose={props.onClose}>
      <p className="hint">
        Al guardar se crea una versión nueva. Las versiones anteriores se conservan, así que los costos y precios
        históricos no cambian.
      </p>
      {!loaded ? (
        <p className="muted">Cargando...</p>
      ) : (
        <form onSubmit={submit}>
          <div className="grid2">
            <Field label="Horas de trabajo por pieza" hint="Puedes usar decimales: 1.5 = una hora y media.">
              <input inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} />
            </Field>
            <Field label="Vigente desde">
              <input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
            </Field>
          </div>
          <h3>Materiales y productos que lleva</h3>
          <table className="table">
            <thead>
              <tr>
                <th>Qué lleva</th>
                <th>Cantidad</th>
                <th>Merma %</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key}>
                  <td>
                    <select value={l.id} onChange={(e) => setLine(l.key, { id: e.target.value })}>
                      <option value="">Elegir...</option>
                      {l.type === 'item'
                        ? props.items.map((i) => (
                            <option key={i.id} value={i.id}>
                              {itemLabel(i)}
                            </option>
                          ))
                        : options.prods.map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.name}
                            </option>
                          ))}
                    </select>
                  </td>
                  <td>
                    <input inputMode="decimal" value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} />
                  </td>
                  <td>
                    <input inputMode="decimal" value={l.waste} onChange={(e) => setLine(l.key, { waste: e.target.value })} />
                  </td>
                  <td>
                    <button type="button" onClick={() => setLines(lines.filter((x) => x.key !== l.key))}>
                      Quitar
                    </button>
                  </td>
                </tr>
              ))}
              {lines.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    Aún no hay renglones.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="actions left">
            <button type="button" onClick={() => addLine('item')}>
              + Material
            </button>
            {props.product.kind !== 'packaging' && (
              <button type="button" onClick={() => addLine('product')}>
                + Otro producto (ej. un amigurumi dentro de un ramo)
              </button>
            )}
          </div>
          <p className="hint">
            Si agregas otro producto, se usa su costo de producción completo; no se vuelven a contar sus materiales. La
            cantidad de un material se escribe en su unidad base (g, pz...).
          </p>
          <Field label="Nota de este cambio (opcional)">
            <input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <ErrorBox message={error} />
          <div className="actions">
            <button type="button" onClick={props.onClose}>
              Cancelar
            </button>
            <button className="primary" disabled={busy}>
              {busy ? 'Guardando...' : 'Guardar versión nueva'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------- publicar precio
function PublishPrice(props: {
  product: Overview
  suggestion: Suggestion
  onSaved: () => void
  onClose: () => void
}) {
  const s = props.suggestion
  const [manual, setManual] = useState(false)
  const [price, setPrice] = useState(String(s.suggested_price))
  const [validFrom, setValidFrom] = useState(todayMX())
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (manual && !isNonNegativeNumber(price)) return setError('Escribe un precio válido.')
    setBusy(true)
    setError('')
    const { error } = await supabase.rpc('publish_product_price', {
      p_product_id: props.product.id,
      p_valid_from: validFrom,
      p_price: manual ? price : null,
      p_note: note.trim() || null,
    })
    setBusy(false)
    if (error) {
      if (error.message.includes('product_prices_product_id_valid_from_key'))
        return setError('Ya hay un precio con esa fecha. Elige otra fecha.')
      return setError(friendlyError(error.message))
    }
    props.onSaved()
  }

  return (
    <Modal title={`Publicar precio de ${props.product.name}`} onClose={props.onClose}>
      <p>
        Precio sugerido hoy: <strong>{money(s.suggested_price)}</strong> (IVA incluido)
      </p>
      <form onSubmit={submit}>
        <label className="inline">
          <input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} /> Poner otro precio
        </label>
        <Field label="Precio con IVA incluido">
          <input inputMode="decimal" value={manual ? price : String(s.suggested_price)} disabled={!manual} onChange={(e) => setPrice(e.target.value)} />
        </Field>
        <Field label="Vigente desde">
          <input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
        </Field>
        <Field label="Nota (opcional)">
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <p className="hint">
          Se guarda también cómo se calculó el sugerido. El precio publicado no se puede editar: para cambiarlo,
          publica uno nuevo con otra fecha.
        </p>
        <ErrorBox message={error} />
        <div className="actions">
          <button type="button" onClick={props.onClose}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Publicando...' : 'Publicar precio'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

// ---------------------------------------------------------------- detalle
function ProductDetail(props: {
  product: Overview
  all: Overview[]
  items: ItemLite[]
  taxRates: TaxRate[]
  isOwner: boolean
  onChanged: () => void
  onClose: () => void
}) {
  const p = props.product
  const [cost, setCost] = useState<Cost | null>(null)
  const [sug, setSug] = useState<Suggestion | null>(null)
  const [versions, setVersions] = useState<VersionRow[]>([])
  const [prices, setPrices] = useState<PriceRow[]>([])
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')
  const [mode, setMode] = useState<'' | 'recipe' | 'price' | 'edit'>('')

  const load = useCallback(async () => {
    setError('')
    const [c, s, v, pr] = await Promise.all([
      supabase.rpc('product_cost', { p_product_id: p.id }),
      supabase.rpc('product_price_suggestion', { p_product_id: p.id }),
      supabase
        .from('product_versions')
        .select('id, version_no, valid_from, labor_hours, notes')
        .eq('product_id', p.id)
        .order('version_no', { ascending: false }),
      supabase
        .from('product_prices')
        .select('id, valid_from, price_incl_tax, suggested_price, note')
        .eq('product_id', p.id)
        .order('valid_from', { ascending: false }),
    ])
    if (c.error) setError(friendlyError(c.error.message))
    else setCost(c.data as Cost)
    // sin receta no hay sugerido: ese error es normal
    setSug(s.error ? null : (s.data as Suggestion))
    if (v.error) setError(friendlyError(v.error.message))
    else setVersions((v.data ?? []) as VersionRow[])
    if (pr.error) setError(friendlyError(pr.error.message))
    else setPrices((pr.data ?? []) as PriceRow[])
  }, [p.id])

  useEffect(() => {
    load()
  }, [load])

  function saved(msg: string) {
    setMode('')
    setOk(msg)
    load()
    props.onChanged()
  }

  const hasRecipe = cost?.has_recipe === true

  return (
    <Modal title={p.name} onClose={props.onClose}>
      <p className="muted small">
        {KIND_LABEL[p.kind]}
        {p.default_packaging_name ? ` · Empaque: ${p.default_packaging_name}` : ''}
      </p>
      <ErrorBox message={error} />
      <OkBox message={ok} />
      <div className="actions left">
        <button className="primary" onClick={() => setMode('recipe')}>
          {hasRecipe ? 'Editar receta' : 'Crear receta'}
        </button>
        <button onClick={() => setMode('edit')}>Datos del producto</button>
        {props.isOwner && (
          <button disabled={!sug} onClick={() => setMode('price')}>
            Publicar precio
          </button>
        )}
      </div>

      {cost && hasRecipe && (
        <>
          <h3>Cómo se calculó el costo (versión {cost.version_no})</h3>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Concepto</th>
                  <th>Cantidad</th>
                  <th>Costo unitario</th>
                  <th>Costo</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Mano de obra</td>
                  <td>{cost.labor_hours} h</td>
                  <td>{money(cost.labor_rate)}/h</td>
                  <td>{money(cost.labor)}</td>
                </tr>
                {cost.lines.map((l) => (
                  <tr key={l.type + l.id}>
                    <td>
                      {l.name}
                      {l.type === 'product' && <span className="pill">producto</span>}
                    </td>
                    <td>
                      {l.qty} {l.unit}
                      {l.waste_pct > 0 ? ` (+${pct(l.waste_pct)} merma)` : ''}
                    </td>
                    <td>{l.unit_cost === null ? 'sin precio' : money(l.unit_cost, 4)}</td>
                    <td>{l.cost === null ? '—' : money(l.cost)}</td>
                  </tr>
                ))}
                <tr>
                  <th colSpan={3}>Costo de producción</th>
                  <th>{money(cost.total)}</th>
                </tr>
              </tbody>
            </table>
          </div>
          {!cost.complete && (
            <ErrorBox message={`Costo incompleto: ${cost.missing.join(', ')}. Registra su precio de compra en Insumos.`} />
          )}
        </>
      )}
      {cost && !hasRecipe && <p className="muted">Este producto todavía no tiene receta.</p>}

      {sug && (
        <>
          <h3>Precio sugerido</h3>
          <ul className="kv">
            <li>
              <span>Método</span>
              <b>
                {sug.method === 'margin' ? 'Margen sobre el precio' : 'Recargo sobre el costo'} · {pct(sug.profit_pct)}
              </b>
            </li>
            <li>
              <span>Precio sin IVA ({pct(sug.iva_rate)} de IVA)</span>
              <b>{money(sug.suggested_ex_tax)}</b>
            </li>
            <li>
              <span>IVA</span>
              <b>{money(sug.suggested_iva)}</b>
            </li>
            <li>
              <span>Comisión de tarjeta incluida en el precio</span>
              <b>
                {sug.card_commission_factor > 0 ? `${pct(sug.card_commission_factor)} ≈ ${money(sug.est_card_commission)}` : 'no se traslada'}
              </b>
            </li>
            {sug.isr_factor > 0 && (
              <li>
                <span>ISR trasladado</span>
                <b>{pct(sug.isr_factor)}</b>
              </li>
            )}
            <li>
              <span>Precio sugerido (IVA incluido)</span>
              <b>{money(sug.suggested_price)}</b>
            </li>
          </ul>
        </>
      )}

      <h3>Precios publicados</h3>
      {prices.length === 0 ? (
        <p className="muted">Aún no hay precio publicado.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Desde</th>
              <th>Precio</th>
              <th>Sugerido entonces</th>
              <th>Nota</th>
            </tr>
          </thead>
          <tbody>
            {prices.map((x) => (
              <tr key={x.id}>
                <td>{displayDate(x.valid_from)}</td>
                <td>{money(x.price_incl_tax)}</td>
                <td>{money(x.suggested_price)}</td>
                <td>{x.note ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Versiones de la receta</h3>
      {versions.length === 0 ? (
        <p className="muted">Sin versiones.</p>
      ) : (
        <ul className="list compact">
          {versions.map((v) => (
            <li key={v.id}>
              <span>
                Versión {v.version_no} · desde {displayDate(v.valid_from)} · {v.labor_hours} h
              </span>
              <span className="muted small">{v.notes ?? ''}</span>
            </li>
          ))}
        </ul>
      )}

      {mode === 'recipe' && (
        <RecipeEditor
          product={p}
          cost={cost}
          items={props.items}
          products={props.all}
          onSaved={() => saved('Receta guardada como versión nueva.')}
          onClose={() => setMode('')}
        />
      )}
      {mode === 'edit' && (
        <ProductForm
          product={p}
          all={props.all}
          taxRates={props.taxRates}
          onSaved={() => saved('Datos guardados.')}
          onClose={() => setMode('')}
        />
      )}
      {mode === 'price' && sug && (
        <PublishPrice product={p} suggestion={sug} onSaved={() => saved('Precio publicado.')} onClose={() => setMode('')} />
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------- lista
export default function Products({ isOwner }: { isOwner: boolean }) {
  const [rows, setRows] = useState<Overview[]>([])
  const [items, setItems] = useState<ItemLite[]>([])
  const [taxRates, setTaxRates] = useState<TaxRate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const [creating, setCreating] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError('')
    const [o, i, t] = await Promise.all([
      supabase.from('v_product_overview').select('*').order('name'),
      supabase
        .from('items')
        .select('id, name, brand, color, base_unit')
        .eq('is_consumable', true)
        .eq('is_active', true)
        .order('name'),
      supabase.from('tax_rates').select('id, code, name').eq('is_active', true).order('name'),
    ])
    if (o.error) setError(friendlyError(o.error.message))
    else setRows((o.data ?? []) as Overview[])
    if (i.error) setError(friendlyError(i.error.message))
    else setItems((i.data ?? []) as ItemLite[])
    if (!t.error) setTaxRates((t.data ?? []) as TaxRate[])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const shown = rows.filter((r) => {
    if (!showInactive && !r.is_active) return false
    if (kind && r.kind !== kind) return false
    if (search && !r.name.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })
  const open = rows.find((r) => r.id === openId) ?? null

  return (
    <div>
      <div className="section-head">
        <h2>Productos</h2>
        <button className="primary" onClick={() => setCreating(true)}>
          + Nuevo producto
        </button>
      </div>
      <div className="filters">
        <input placeholder="Buscar..." value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">Todos los tipos</option>
          {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <label className="inline">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Ver inactivos
        </label>
      </div>
      <ErrorBox message={error} />
      {loading ? (
        <p className="muted">Cargando...</p>
      ) : shown.length === 0 ? (
        <p className="muted">
          {rows.length === 0 ? 'Aún no hay productos. Crea el primero con “Nuevo producto”.' : 'Nada coincide con el filtro.'}
        </p>
      ) : (
        <div className="table-wrap">
          <table className="table clickable">
            <thead>
              <tr>
                <th>Producto</th>
                <th>Tipo</th>
                <th>Costo</th>
                <th>Sugerido</th>
                <th>Precio publicado</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className={r.is_active ? '' : 'inactive'} onClick={() => setOpenId(r.id)}>
                  <td>
                    {r.name}
                    {r.code && <span className="pill">{r.code}</span>}
                  </td>
                  <td>{KIND_LABEL[r.kind]}</td>
                  <td>
                    {r.has_recipe ? money(r.cost_total_text) : <span className="muted">sin receta</span>}
                    {r.has_recipe && r.cost_complete === false && <span className="pill">incompleto</span>}
                  </td>
                  <td>{r.has_recipe ? money(r.suggested_price) : '—'}</td>
                  <td>{r.current_price === null ? '—' : money(r.current_price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && (
        <ProductForm
          product={null}
          all={rows}
          taxRates={taxRates}
          onSaved={() => {
            setCreating(false)
            load()
          }}
          onClose={() => setCreating(false)}
        />
      )}
      {open && (
        <ProductDetail
          product={open}
          all={rows}
          items={items}
          taxRates={taxRates}
          isOwner={isOwner}
          onChanged={load}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  )
}
