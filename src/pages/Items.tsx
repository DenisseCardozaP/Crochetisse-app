import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { supabase } from '../supabase'
import {
  costPerUnitPreview,
  friendlyError,
  isNonNegativeNumber,
  isPositiveNumber,
  money,
  todayMX,
} from '../format'
import { ErrorBox, Field, Modal } from '../ui'

type Kind = 'material' | 'packaging' | 'resale'

const KIND_LABEL: Record<Kind, string> = {
  material: 'Material (producción)',
  packaging: 'Empaque',
  resale: 'Para venta (reventa)',
}

interface ItemRow {
  id: string
  sku: string | null
  name: string
  kind: Kind
  category_id: string | null
  category_name: string | null
  brand: string | null
  color: string | null
  color_code: string | null
  purchase_unit: string
  base_unit: string
  units_per_purchase: number
  min_stock: number
  content_qty: number | null
  content_unit: string | null
  price_group_id: string | null
  price_group_name: string | null
  is_consumable: boolean
  is_sellable: boolean
  tax_rate_id: string | null
  default_supplier_id: string | null
  supplier_name: string | null
  notes: string | null
  is_active: boolean
  current_purchase_price: number | null
  current_unit_cost: number | null
  price_valid_from: string | null
}

interface Option {
  id: string
  name: string
}

interface TaxOption {
  id: string
  name: string
  code: string
}

interface PriceRow {
  id: string
  valid_from: string
  purchase_price: number
  purchase_unit_qty: number
  unit_cost_base: number
  supplier_id: string | null
  note: string | null
  created_at: string
}

function useLookups() {
  const [suppliers, setSuppliers] = useState<Option[]>([])
  const [categories, setCategories] = useState<Option[]>([])
  const [taxes, setTaxes] = useState<TaxOption[]>([])
  const [groups, setGroups] = useState<Option[]>([])
  useEffect(() => {
    ;(async () => {
      const [s, c, t, g] = await Promise.all([
        supabase.from('suppliers').select('id, name').eq('is_active', true).order('name'),
        supabase.from('categories').select('id, name').eq('kind', 'item').eq('is_active', true).order('name'),
        supabase.from('tax_rates').select('id, name, code').eq('is_active', true).order('name'),
        supabase.from('price_groups').select('id, name').eq('is_active', true).order('name'),
      ])
      if (s.data) setSuppliers(s.data as Option[])
      if (c.data) setCategories(c.data as Option[])
      if (t.data) setTaxes(t.data as TaxOption[])
      if (g.data) setGroups(g.data as Option[])
    })()
  }, [])
  return { suppliers, categories, taxes, groups }
}

function ItemForm(props: {
  initial: ItemRow | null
  presentationLocked: boolean
  lookups: ReturnType<typeof useLookups>
  onSaved: (id: string) => void
  onClose: () => void
}) {
  const { initial, lookups } = props
  const [name, setName] = useState(initial?.name ?? '')
  const [kind, setKind] = useState<Kind>(initial?.kind ?? 'material')
  const [brand, setBrand] = useState(initial?.brand ?? '')
  const [color, setColor] = useState(initial?.color ?? '')
  const [colorCode, setColorCode] = useState(initial?.color_code ?? '')
  const [purchaseUnit, setPurchaseUnit] = useState(initial?.purchase_unit ?? '')
  const [baseUnit, setBaseUnit] = useState(initial?.base_unit ?? '')
  const [unitsPer, setUnitsPer] = useState(initial ? String(initial.units_per_purchase) : '')
  const [contentQty, setContentQty] = useState(initial?.content_qty != null ? String(initial.content_qty) : '')
  const [contentUnit, setContentUnit] = useState(initial?.content_unit ?? '')
  const [groupId, setGroupId] = useState(initial?.price_group_id ?? '')
  const [minStock, setMinStock] = useState(initial ? String(initial.min_stock) : '0')
  const [consumable, setConsumable] = useState(initial?.is_consumable ?? true)
  const [sellable, setSellable] = useState(initial?.is_sellable ?? false)
  const [supplierId, setSupplierId] = useState(initial?.default_supplier_id ?? '')
  const [categoryId, setCategoryId] = useState(initial?.category_id ?? '')
  const [taxId, setTaxId] = useState(initial?.tax_rate_id ?? '')
  const [notes, setNotes] = useState(initial?.notes ?? '')
  const [isActive, setIsActive] = useState(initial?.is_active ?? true)
  const [price, setPrice] = useState('')
  const [priceDate, setPriceDate] = useState(todayMX())
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const locked = props.presentationLocked
  // Un artículo de venta se cuenta por su unidad de venta (ej. madeja): unidad de compra = de consumo, y trae 1.
  const isResale = kind === 'resale'
  const effUnits = isResale ? '1' : unitsPer

  function changeKind(k: Kind) {
    setKind(k)
    if (!initial) {
      if (k === 'resale') {
        setConsumable(false)
        setSellable(true)
      } else {
        setConsumable(true)
        setSellable(false)
      }
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return setError('Escribe el nombre.')
    if (!purchaseUnit.trim()) {
      return setError(isResale ? 'Escribe la unidad de venta (por ejemplo: madeja).' : 'Escribe la unidad de compra (por ejemplo: madeja).')
    }
    if (!isResale && !baseUnit.trim()) return setError('Escribe la unidad de consumo (por ejemplo: g).')
    if (!isResale && !isPositiveNumber(unitsPer)) return setError('La cantidad por unidad de compra debe ser mayor a 0.')
    if (isResale && (contentQty.trim() !== '' || contentUnit.trim() !== '')) {
      if (!isPositiveNumber(contentQty) || !contentUnit.trim()) {
        return setError('Si indicas el contenido, escribe la cantidad (mayor a 0) y su unidad. Ejemplo: 100 g.')
      }
    }
    if (!isNonNegativeNumber(minStock)) return setError('El stock mínimo no puede ser negativo.')
    if (!consumable && !sellable) return setError('Marca si se usa en producción, si se vende, o ambas.')
    if (price.trim() !== '' && !isNonNegativeNumber(price)) return setError('El precio de compra no es válido.')

    setBusy(true)
    setError('')
    const base = {
      name: name.trim(),
      brand: brand.trim() || null,
      color: color.trim() || null,
      color_code: colorCode.trim() || null,
      min_stock: minStock,
      is_consumable: consumable,
      is_sellable: sellable,
      default_supplier_id: supplierId || null,
      category_id: categoryId || null,
      tax_rate_id: taxId || null,
      notes: notes.trim() || null,
      is_active: isActive,
      content_qty: isResale && contentQty.trim() !== '' ? contentQty : null,
      content_unit: isResale && contentQty.trim() !== '' ? contentUnit.trim() : null,
      price_group_id: isResale ? groupId || null : null,
    }
    const effBase = isResale ? purchaseUnit.trim() : baseUnit.trim()

    if (initial) {
      const payload = locked
        ? base
        : { ...base, kind, purchase_unit: purchaseUnit.trim(), base_unit: effBase, units_per_purchase: effUnits }
      const { error } = await supabase.from('items').update(payload).eq('id', initial.id)
      setBusy(false)
      if (error) return setError(friendlyError(error.message))
      props.onSaved(initial.id)
      return
    }

    const { data, error } = await supabase
      .from('items')
      .insert({
        ...base,
        kind,
        purchase_unit: purchaseUnit.trim(),
        base_unit: effBase,
        units_per_purchase: effUnits,
      })
      .select('id')
      .single()
    if (error || !data) {
      setBusy(false)
      return setError(friendlyError(error?.message ?? 'No se pudo guardar.'))
    }
    const newId = (data as { id: string }).id
    if (price.trim() !== '') {
      const p = await supabase.from('item_price_history').insert({
        item_id: newId,
        valid_from: priceDate,
        purchase_price: price,
        supplier_id: supplierId || null,
        source: 'manual',
      })
      if (p.error) {
        setBusy(false)
        setError('El insumo se creó, pero el precio no se pudo guardar: ' + friendlyError(p.error.message))
        return
      }
    }
    setBusy(false)
    props.onSaved(newId)
  }

  return (
    <Modal title={initial ? 'Editar insumo' : 'Nuevo insumo'} onClose={props.onClose}>
      <form onSubmit={submit}>
        <div className="grid2">
          <Field label="Nombre">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Estambre" />
          </Field>
          <Field label="Tipo">
            <select value={kind} onChange={(e) => changeKind(e.target.value as Kind)} disabled={locked}>
              {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Marca">
            <input value={brand} onChange={(e) => setBrand(e.target.value)} />
          </Field>
          <Field label="Color">
            <input value={color} onChange={(e) => setColor(e.target.value)} />
          </Field>
          <Field label="Código de color">
            <input value={colorCode} onChange={(e) => setColorCode(e.target.value)} />
          </Field>
          <Field label="Categoría">
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Sin categoría</option>
              {lookups.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <h3>{isResale ? 'Presentación de venta' : 'Presentación de compra'}</h3>
        {locked && (
          <p className="hint">
            Este insumo ya tiene precios registrados, así que su presentación no se puede cambiar. Si cambió, crea un
            insumo nuevo.
          </p>
        )}
        {isResale ? (
          <>
            <div className="grid3">
              <Field label="Unidad de venta" hint="Se cuenta y se vende así: madeja, pieza...">
                <input
                  list="purchase-units"
                  value={purchaseUnit}
                  onChange={(e) => setPurchaseUnit(e.target.value)}
                  disabled={locked}
                />
              </Field>
              <Field label="Cada unidad contiene" hint="Ejemplo: 100">
                <input inputMode="decimal" value={contentQty} onChange={(e) => setContentQty(e.target.value)} />
              </Field>
              <Field label="Unidad del contenido" hint="g, m...">
                <input list="base-units" value={contentUnit} onChange={(e) => setContentUnit(e.target.value)} />
              </Field>
            </div>
            <Field label="Grupo de precio" hint="Los precios por cantidad se definen una vez por grupo (pestaña Precios de venta)">
              <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                <option value="">Sin grupo</option>
                {lookups.groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </Field>
          </>
        ) : (
        <div className="grid3">
          <Field label="Unidad de compra" hint="madeja, paquete, rollo, bolsa...">
            <input
              list="purchase-units"
              value={purchaseUnit}
              onChange={(e) => setPurchaseUnit(e.target.value)}
              disabled={locked}
            />
          </Field>
          <Field label="Cantidad que trae" hint="Ejemplo: 100">
            <input
              inputMode="decimal"
              value={unitsPer}
              onChange={(e) => setUnitsPer(e.target.value)}
              disabled={locked}
            />
          </Field>
          <Field label="Unidad de consumo" hint="g, m, pz, ml...">
            <input list="base-units" value={baseUnit} onChange={(e) => setBaseUnit(e.target.value)} disabled={locked} />
          </Field>
        </div>
        )}
        <datalist id="purchase-units">
          {['pieza', 'paquete', 'madeja', 'rollo', 'bolsa', 'caja', 'kilogramo', 'litro'].map((u) => (
            <option key={u} value={u} />
          ))}
        </datalist>
        <datalist id="base-units">
          {['g', 'm', 'pz', 'ml', 'cm'].map((u) => (
            <option key={u} value={u} />
          ))}
        </datalist>

        {!initial && (
          <>
            <h3>Precio de compra (opcional)</h3>
            <div className="grid3">
              <Field label="Precio por unidad de compra">
                <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="70" />
              </Field>
              <Field label="Vigente desde">
                <input type="date" value={priceDate} onChange={(e) => setPriceDate(e.target.value)} />
              </Field>
              <Field label="Costo por unidad de consumo">
                <input readOnly value={price.trim() === '' ? '—' : costPerUnitPreview(price, effUnits)} />
              </Field>
            </div>
          </>
        )}

        <h3>Uso y control</h3>
        <div className="checks">
          <label className="inline">
            <input type="checkbox" checked={consumable} onChange={(e) => setConsumable(e.target.checked)} />
            Se usa en producción
          </label>
          <label className="inline">
            <input type="checkbox" checked={sellable} onChange={(e) => setSellable(e.target.checked)} />
            Se vende
          </label>
          {initial && (
            <label className="inline">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
              Activo
            </label>
          )}
        </div>
        <div className="grid3">
          <Field label="Stock mínimo" hint="En unidad de consumo">
            <input inputMode="decimal" value={minStock} onChange={(e) => setMinStock(e.target.value)} />
          </Field>
          <Field label="Proveedor">
            <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">Sin proveedor</option>
              {lookups.suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="IVA">
            <select value={taxId} onChange={(e) => setTaxId(e.target.value)}>
              <option value="">Sin definir</option>
              {lookups.taxes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Notas">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
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

function Detail(props: {
  item: ItemRow
  lookups: ReturnType<typeof useLookups>
  onEdit: (hasHistory: boolean) => void
  onChanged: () => void
  onClose: () => void
}) {
  const { item, lookups } = props
  const [history, setHistory] = useState<PriceRow[]>([])
  const [price, setPrice] = useState('')
  const [date, setDate] = useState(todayMX())
  const [supplierId, setSupplierId] = useState(item.default_supplier_id ?? '')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const loadHistory = useCallback(async () => {
    const { data, error } = await supabase
      .from('item_price_history')
      .select('id, valid_from, purchase_price, purchase_unit_qty, unit_cost_base, supplier_id, note, created_at')
      .eq('item_id', item.id)
      .order('valid_from', { ascending: false })
      .order('created_at', { ascending: false })
    if (error) setError(friendlyError(error.message))
    else setHistory(data as PriceRow[])
  }, [item.id])

  useEffect(() => {
    loadHistory()
  }, [loadHistory])

  async function addPrice(e: FormEvent) {
    e.preventDefault()
    if (!isNonNegativeNumber(price) || price.trim() === '') return setError('Escribe un precio válido.')
    setBusy(true)
    setError('')
    const { error } = await supabase.from('item_price_history').insert({
      item_id: item.id,
      valid_from: date,
      purchase_price: price,
      supplier_id: supplierId || null,
      note: note.trim() || null,
      source: 'manual',
    })
    setBusy(false)
    if (error) return setError(friendlyError(error.message))
    setPrice('')
    setNote('')
    await loadHistory()
    props.onChanged()
  }

  const supplierName = (id: string | null) => lookups.suppliers.find((s) => s.id === id)?.name ?? '—'

  return (
    <Modal title={item.name} onClose={props.onClose}>
      <p className="muted">
        {[KIND_LABEL[item.kind], item.brand, item.color, item.color_code].filter(Boolean).join(' · ')}
      </p>
      {item.kind === 'resale' ? (
        <p>
          Se vende por <strong>{item.purchase_unit}</strong>
          {item.content_qty ? ` (cada una contiene ${item.content_qty} ${item.content_unit})` : ''}. Costo de compra actual:{' '}
          <strong>{money(item.current_purchase_price)}</strong> por {item.purchase_unit}
          {item.price_group_name ? `. Grupo de precio: ${item.price_group_name}.` : '.'}
        </p>
      ) : (
        <p>
          Se compra por <strong>{item.purchase_unit}</strong> de {item.units_per_purchase} {item.base_unit}. Costo actual:{' '}
          <strong>
            {money(item.current_purchase_price)} por {item.purchase_unit}
          </strong>{' '}
          ({money(item.current_unit_cost, 4)} por {item.base_unit}).
        </p>
      )}
      <p className="muted small">
        {item.is_consumable && 'Se usa en producción. '}
        {item.is_sellable && 'Se vende. '}Stock mínimo: {item.min_stock} {item.base_unit}.
      </p>
      <div className="actions left">
        <button onClick={() => props.onEdit(history.length > 0)}>Editar datos</button>
      </div>

      <h3>Registrar precio nuevo</h3>
      <form onSubmit={addPrice}>
        <div className="grid3">
          <Field label={`Precio por ${item.purchase_unit}`}>
            <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
          </Field>
          <Field label="Vigente desde">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Costo por unidad de consumo">
            <input readOnly value={price.trim() === '' ? '—' : costPerUnitPreview(price, String(item.units_per_purchase))} />
          </Field>
        </div>
        <div className="grid2">
          <Field label="Proveedor">
            <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">Sin proveedor</option>
              {lookups.suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Nota">
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        <ErrorBox message={error} />
        <div className="actions left">
          <button className="primary" disabled={busy}>
            {busy ? 'Guardando...' : 'Guardar precio'}
          </button>
        </div>
      </form>

      <h3>Historial de precios</h3>
      {history.length === 0 ? (
        <p className="muted">Todavía no hay precios registrados.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Desde</th>
              <th>Precio</th>
              <th>Por {item.base_unit}</th>
              <th>Proveedor</th>
              <th>Nota</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.id}>
                <td>{h.valid_from}</td>
                <td>{money(h.purchase_price)}</td>
                <td>{money(h.unit_cost_base, 4)}</td>
                <td>{supplierName(h.supplier_id)}</td>
                <td>{h.note ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">Los precios anteriores no se pueden editar ni borrar: así los costos viejos quedan intactos.</p>
    </Modal>
  )
}

export default function Items() {
  const lookups = useLookups()
  const [rows, setRows] = useState<ItemRow[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [kindFilter, setKindFilter] = useState<'all' | Kind>('all')
  const [showInactive, setShowInactive] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [form, setForm] = useState<{ item: ItemRow | null; locked: boolean } | null>(null)

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('v_item_list').select('*').order('name')
    setLoading(false)
    if (error) setError(friendlyError(error.message))
    else {
      setError('')
      setRows(data as ItemRow[])
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((r) => {
      if (!showInactive && !r.is_active) return false
      if (kindFilter !== 'all' && r.kind !== kindFilter) return false
      if (!q) return true
      return [r.name, r.brand, r.color, r.color_code, r.supplier_name, r.category_name]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    })
  }, [rows, search, kindFilter, showInactive])

  const detailItem = rows.find((r) => r.id === detailId) ?? null

  return (
    <div>
      <div className="section-head">
        <h2>Insumos</h2>
        <button className="primary" onClick={() => setForm({ item: null, locked: false })}>
          + Nuevo insumo
        </button>
      </div>
      <div className="filters">
        <input placeholder="Buscar por nombre, marca, color..." value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value as 'all' | Kind)}>
          <option value="all">Todos los tipos</option>
          {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <label className="inline">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Mostrar inactivos
        </label>
      </div>
      <ErrorBox message={error} />
      {loading ? (
        <p className="muted">Cargando...</p>
      ) : filtered.length === 0 ? (
        <p className="muted">
          {rows.length === 0 ? 'Todavía no hay insumos. Crea el primero con "Nuevo insumo".' : 'Nada coincide con tu búsqueda.'}
        </p>
      ) : (
        <div className="table-wrap">
          <table className="table clickable">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Tipo</th>
                <th>Presentación</th>
                <th>Precio de compra</th>
                <th>Costo por unidad</th>
                <th>Proveedor</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className={r.is_active ? '' : 'inactive'} onClick={() => setDetailId(r.id)}>
                  <td>
                    <strong>{r.name}</strong>
                    <div className="muted small">{[r.brand, r.color, r.color_code].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td>
                    {KIND_LABEL[r.kind]}
                    {!r.is_active && <span className="pill">Inactivo</span>}
                  </td>
                  <td>
                    {r.kind === 'resale'
                      ? `${r.purchase_unit}${r.content_qty ? ` · ${r.content_qty} ${r.content_unit}` : ''}`
                      : `${r.purchase_unit} de ${r.units_per_purchase} ${r.base_unit}`}
                  </td>
                  <td>{money(r.current_purchase_price)}</td>
                  <td>
                    {r.current_unit_cost === null ? '—' : `${money(r.current_unit_cost, 4)} / ${r.base_unit}`}
                  </td>
                  <td>{r.supplier_name ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detailItem && form === null && (
        <Detail
          item={detailItem}
          lookups={lookups}
          onClose={() => setDetailId(null)}
          onChanged={load}
          onEdit={(hasHistory) => setForm({ item: detailItem, locked: hasHistory })}
        />
      )}

      {form !== null && (
        <ItemForm
          initial={form.item}
          presentationLocked={form.locked}
          lookups={lookups}
          onClose={() => setForm(null)}
          onSaved={async (id) => {
            setForm(null)
            await load()
            setDetailId(id)
          }}
        />
      )}
    </div>
  )
}
