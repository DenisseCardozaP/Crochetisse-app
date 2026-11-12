import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { supabase } from '../supabase'
import { displayDate, friendlyError, isNonNegativeNumber, isPositiveNumber, money, todayMX } from '../format'
import { ErrorBox, Field, Modal, OkBox } from '../ui'

interface Group {
  id: string
  name: string
  description: string | null
  is_active: boolean
}

interface Tier {
  group_id: string
  audience: 'customer' | 'internal'
  valid_from: string
  min_qty: number
  unit_price: number
}

interface ItemLite {
  price_group_id: string | null
  is_active: boolean
  current_purchase_price: number | null
}

function rangeLabel(tiers: Tier[], i: number): string {
  const from = tiers[i].min_qty
  const next = tiers[i + 1]
  if (!next) return `${from} o más`
  const to = next.min_qty - 1
  return from === to ? `${from}` : `${from} a ${to}`
}

function NewGroupForm(props: { onSaved: () => void; onClose: () => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return setError('Escribe el nombre del grupo (por ejemplo: la marca o la línea).')
    setBusy(true)
    setError('')
    const { error } = await supabase
      .from('price_groups')
      .insert({ name: name.trim(), description: description.trim() || null })
    setBusy(false)
    if (error) {
      if (error.message.includes('price_groups_name_unique')) return setError('Ya existe un grupo con ese nombre.')
      return setError(friendlyError(error.message))
    }
    props.onSaved()
  }

  return (
    <Modal title="Nuevo grupo de precio" onClose={props.onClose}>
      <form onSubmit={submit}>
        <Field label="Nombre" hint="Ejemplo: Alize Velluto. Todos sus colores compartirán los precios.">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Descripción (opcional)">
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <ErrorBox message={error} />
        <div className="actions">
          <button type="button" onClick={props.onClose}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Guardando...' : 'Crear grupo'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

interface Row {
  qty: string
  price: string
}

function TiersForm(props: { group: Group; current: Tier[]; onSaved: () => void; onClose: () => void }) {
  const [from, setFrom] = useState(todayMX())
  const [rows, setRows] = useState<Row[]>(
    props.current.length > 0
      ? props.current.map((t) => ({ qty: String(t.min_qty), price: String(t.unit_price) }))
      : [{ qty: '1', price: '' }],
  )
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const setRow = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))

  async function submit(e: FormEvent) {
    e.preventDefault()
    const parsed: { min_qty: number; unit_price: number }[] = []
    for (const r of rows) {
      if (!/^\d+$/.test(r.qty.trim()) || Number(r.qty) < 1) return setError('Las cantidades deben ser números enteros desde 1.')
      if (!isNonNegativeNumber(r.price) || r.price.trim() === '') return setError('Todos los escalones necesitan un precio válido.')
      parsed.push({ min_qty: Number(r.qty), unit_price: Number(r.price) })
    }
    parsed.sort((a, b) => a.min_qty - b.min_qty)
    if (parsed[0].min_qty !== 1) return setError('El primer escalón debe empezar en 1 pieza.')
    for (let i = 1; i < parsed.length; i++) {
      if (parsed[i].min_qty === parsed[i - 1].min_qty) return setError('Hay dos escalones con la misma cantidad.')
      if (parsed[i].unit_price > parsed[i - 1].unit_price) return setError('El precio no puede subir al comprar más piezas.')
    }
    setBusy(true)
    setError('')
    const { error } = await supabase.rpc('set_group_prices', {
      p_group_id: props.group.id,
      p_audience: 'customer',
      p_valid_from: from,
      p_tiers: parsed,
    })
    setBusy(false)
    if (error) return setError(friendlyError(error.message))
    props.onSaved()
  }

  return (
    <Modal title={`Precios a clientes: ${props.group.name}`} onClose={props.onClose}>
      <form onSubmit={submit}>
        <p className="muted small">
          Precio por pieza, con IVA incluido. Se guarda el juego completo con una fecha de inicio; los precios anteriores
          se conservan.
        </p>
        <Field label="Rige desde">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <table className="table">
          <thead>
            <tr>
              <th>Desde (piezas)</th>
              <th>Precio por pieza</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>
                  <input inputMode="numeric" value={r.qty} onChange={(e) => setRow(i, { qty: e.target.value })} />
                </td>
                <td>
                  <input inputMode="decimal" value={r.price} onChange={(e) => setRow(i, { price: e.target.value })} />
                </td>
                <td>
                  {rows.length > 1 && (
                    <button type="button" onClick={() => setRows((rs) => rs.filter((_, idx) => idx !== i))}>
                      Quitar
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="actions left">
          <button type="button" onClick={() => setRows((rs) => [...rs, { qty: '', price: '' }])}>
            + Agregar escalón
          </button>
        </div>
        <ErrorBox message={error} />
        <div className="actions">
          <button type="button" onClick={props.onClose}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Guardando...' : 'Guardar precios'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function InternalForm(props: { group: Group; current: Tier | null; onSaved: () => void; onClose: () => void }) {
  const [from, setFrom] = useState(todayMX())
  const [price, setPrice] = useState(props.current ? String(props.current.unit_price) : '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (price.trim() === '' || !isNonNegativeNumber(price)) return setError('Escribe un precio válido.')
    setBusy(true)
    setError('')
    const { error } = await supabase.rpc('set_group_prices', {
      p_group_id: props.group.id,
      p_audience: 'internal',
      p_valid_from: from,
      p_tiers: [{ min_qty: 1, unit_price: Number(price) }],
    })
    setBusy(false)
    if (error) return setError(friendlyError(error.message))
    props.onSaved()
  }

  return (
    <Modal title={`Precio interno: ${props.group.name}`} onClose={props.onClose}>
      <form onSubmit={submit}>
        <p className="muted small">
          Es lo que te "cobras" a ti misma cuando pasas una madeja a producción. No cuenta como venta a un cliente.
        </p>
        <div className="grid2">
          <Field label="Precio por pieza">
            <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
          </Field>
          <Field label="Rige desde">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
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

function CostForm(props: { group: Group; count: number; onSaved: (n: number) => void; onClose: () => void }) {
  const [from, setFrom] = useState(todayMX())
  const [price, setPrice] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!isPositiveNumber(price)) return setError('Escribe el costo de compra por madeja (mayor a 0).')
    setBusy(true)
    setError('')
    const { data, error } = await supabase.rpc('set_group_purchase_price', {
      p_group_id: props.group.id,
      p_price: Number(price),
      p_valid_from: from,
      p_note: note.trim() || null,
    })
    setBusy(false)
    if (error) return setError(friendlyError(error.message))
    props.onSaved(Number(data ?? 0))
  }

  return (
    <Modal title={`Costo de compra: ${props.group.name}`} onClose={props.onClose}>
      <form onSubmit={submit}>
        <p className="muted small">
          Se registra el mismo costo por pieza en los {props.count} insumos activos del grupo. Si compras paquetes de 5,
          divide el precio del paquete entre 5.
        </p>
        <div className="grid2">
          <Field label="Costo por madeja (MXN)">
            <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
          </Field>
          <Field label="Rige desde">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
        </div>
        <Field label="Nota (opcional)">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ejemplo: paquete de 5 a $250" />
        </Field>
        <ErrorBox message={error} />
        <div className="actions">
          <button type="button" onClick={props.onClose}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Guardando...' : 'Registrar costo'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

type Dialog =
  | { kind: 'new' }
  | { kind: 'tiers'; group: Group }
  | { kind: 'internal'; group: Group }
  | { kind: 'cost'; group: Group }

export default function PriceGroups({ isOwner }: { isOwner: boolean }) {
  const [groups, setGroups] = useState<Group[]>([])
  const [tiers, setTiers] = useState<Tier[]>([])
  const [items, setItems] = useState<ItemLite[]>([])
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')
  const [dialog, setDialog] = useState<Dialog | null>(null)

  const load = useCallback(async () => {
    const [g, t, i] = await Promise.all([
      supabase.from('price_groups').select('*').order('name'),
      supabase.from('v_group_prices_current').select('*'),
      supabase.from('v_item_list').select('price_group_id, is_active, current_purchase_price'),
    ])
    const err = g.error ?? t.error ?? i.error
    if (err) return setError(friendlyError(err.message))
    setError('')
    setGroups((g.data as Group[]) ?? [])
    setTiers((t.data as Tier[]) ?? [])
    setItems((i.data as ItemLite[]) ?? [])
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const byGroup = useMemo(() => {
    const map = new Map<string, { customer: Tier[]; internal: Tier | null; items: ItemLite[] }>()
    for (const g of groups) map.set(g.id, { customer: [], internal: null, items: [] })
    for (const t of tiers) {
      const e = map.get(t.group_id)
      if (!e) continue
      if (t.audience === 'customer') e.customer.push(t)
      else e.internal = t
    }
    for (const it of items) {
      if (it.price_group_id) map.get(it.price_group_id)?.items.push(it)
    }
    for (const e of map.values()) e.customer.sort((a, b) => a.min_qty - b.min_qty)
    return map
  }, [groups, tiers, items])

  function saved(message: string) {
    setDialog(null)
    setOk(message)
    load()
  }

  return (
    <div>
      <div className="section-head">
        <h2>Precios de venta</h2>
        {isOwner && (
          <button className="primary" onClick={() => setDialog({ kind: 'new' })}>
            + Nuevo grupo
          </button>
        )}
      </div>
      <p className="muted small">
        Un grupo reúne los colores de una misma marca o línea. Los precios por cantidad se definen una vez por grupo y las
        piezas se cuentan entre todos sus colores. Los precios llevan IVA incluido.
      </p>
      <ErrorBox message={error} />
      <OkBox message={ok} />
      {groups.length === 0 && <p className="muted">Todavía no hay grupos de precio.</p>}

      {groups.map((g) => {
        const d = byGroup.get(g.id)
        if (!d) return null
        const active = d.items.filter((x) => x.is_active)
        const costs = active.map((x) => x.current_purchase_price).filter((x): x is number => x !== null)
        const withoutCost = active.length - costs.length
        let costText = 'Sin registrar'
        if (costs.length > 0) {
          const min = Math.min(...costs)
          const max = Math.max(...costs)
          costText = min === max ? `${money(min)} por madeja` : `${money(min)} a ${money(max)} por madeja`
          if (withoutCost > 0) costText += ` (${withoutCost} sin costo)`
        }
        return (
          <div key={g.id} className="group-card">
            <div className="section-head">
              <h3 className="grow">
                {g.name} <span className="pill">{active.length} colores</span>
              </h3>
            </div>
            {g.description && <p className="muted small">{g.description}</p>}

            <h4>Precio a clientes</h4>
            {d.customer.length === 0 ? (
              <p className="muted">Sin precios.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Piezas</th>
                    <th>Precio por pieza</th>
                  </tr>
                </thead>
                <tbody>
                  {d.customer.map((t, i) => (
                    <tr key={t.min_qty}>
                      <td>{rangeLabel(d.customer, i)}</td>
                      <td>{money(t.unit_price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {d.customer[0] && <p className="muted small">Rige desde: {displayDate(d.customer[0].valid_from)}</p>}

            <ul className="kv">
              <li>
                <span>Precio interno (a producción)</span>
                <strong>{d.internal ? money(d.internal.unit_price) : 'Sin definir'}</strong>
              </li>
              <li>
                <span>Costo de compra actual</span>
                <strong>{costText}</strong>
              </li>
            </ul>

            <div className="actions left">
              {isOwner && <button onClick={() => setDialog({ kind: 'tiers', group: g })}>Cambiar precios a clientes</button>}
              {isOwner && <button onClick={() => setDialog({ kind: 'internal', group: g })}>Cambiar precio interno</button>}
              <button onClick={() => setDialog({ kind: 'cost', group: g })}>Costo de compra del grupo</button>
            </div>
          </div>
        )
      })}

      {dialog?.kind === 'new' && <NewGroupForm onClose={() => setDialog(null)} onSaved={() => saved('Grupo creado.')} />}
      {dialog?.kind === 'tiers' && (
        <TiersForm
          group={dialog.group}
          current={byGroup.get(dialog.group.id)?.customer ?? []}
          onClose={() => setDialog(null)}
          onSaved={() => saved('Precios guardados. Los anteriores se conservan en el historial.')}
        />
      )}
      {dialog?.kind === 'internal' && (
        <InternalForm
          group={dialog.group}
          current={byGroup.get(dialog.group.id)?.internal ?? null}
          onClose={() => setDialog(null)}
          onSaved={() => saved('Precio interno guardado.')}
        />
      )}
      {dialog?.kind === 'cost' && (
        <CostForm
          group={dialog.group}
          count={(byGroup.get(dialog.group.id)?.items ?? []).filter((x) => x.is_active).length}
          onClose={() => setDialog(null)}
          onSaved={(n) => saved(`Costo registrado en ${n} insumos.`)}
        />
      )}
    </div>
  )
}
