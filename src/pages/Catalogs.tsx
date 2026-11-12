import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { supabase } from '../supabase'
import { friendlyError } from '../format'
import { ErrorBox, Field, Modal } from '../ui'

interface Supplier {
  id: string
  name: string
  contact: string | null
  notes: string | null
  is_active: boolean
}

interface Category {
  id: string
  kind: 'item' | 'product' | 'expense'
  name: string
  is_active: boolean
}

const KIND_LABEL: Record<Category['kind'], string> = {
  item: 'Insumos',
  product: 'Productos',
  expense: 'Gastos',
}

function SupplierForm(props: { initial: Supplier | null; onSaved: () => void; onClose: () => void }) {
  const [name, setName] = useState(props.initial?.name ?? '')
  const [contact, setContact] = useState(props.initial?.contact ?? '')
  const [notes, setNotes] = useState(props.initial?.notes ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) {
      setError('Escribe el nombre del proveedor.')
      return
    }
    setBusy(true)
    setError('')
    const payload = {
      name: name.trim(),
      contact: contact.trim() || null,
      notes: notes.trim() || null,
    }
    const { error } = props.initial
      ? await supabase.from('suppliers').update(payload).eq('id', props.initial.id)
      : await supabase.from('suppliers').insert(payload)
    setBusy(false)
    if (error) {
      setError(friendlyError(error.message))
      return
    }
    props.onSaved()
  }

  return (
    <Modal title={props.initial ? 'Editar proveedor' : 'Nuevo proveedor'} onClose={props.onClose}>
      <form onSubmit={submit}>
        <Field label="Nombre">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Contacto" hint="Teléfono, correo o dirección (opcional)">
          <input value={contact} onChange={(e) => setContact(e.target.value)} />
        </Field>
        <Field label="Notas">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
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

export default function Catalogs() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Supplier | null | 'new'>(null)
  const [showInactive, setShowInactive] = useState(false)
  const [catName, setCatName] = useState('')
  const [catKind, setCatKind] = useState<Category['kind']>('item')

  const load = useCallback(async () => {
    const [s, c] = await Promise.all([
      supabase.from('suppliers').select('*').order('name'),
      supabase.from('categories').select('*').order('kind').order('name'),
    ])
    if (s.error) setError(friendlyError(s.error.message))
    else if (c.error) setError(friendlyError(c.error.message))
    else {
      setError('')
      setSuppliers(s.data as Supplier[])
      setCategories(c.data as Category[])
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function toggleSupplier(s: Supplier) {
    const { error } = await supabase.from('suppliers').update({ is_active: !s.is_active }).eq('id', s.id)
    if (error) setError(friendlyError(error.message))
    else load()
  }

  async function addCategory(e: FormEvent) {
    e.preventDefault()
    if (!catName.trim()) return
    const { error } = await supabase.from('categories').insert({ kind: catKind, name: catName.trim() })
    if (error) {
      setError(friendlyError(error.message))
      return
    }
    setCatName('')
    load()
  }

  async function toggleCategory(c: Category) {
    const { error } = await supabase.from('categories').update({ is_active: !c.is_active }).eq('id', c.id)
    if (error) setError(friendlyError(error.message))
    else load()
  }

  const shownSuppliers = suppliers.filter((s) => showInactive || s.is_active)

  return (
    <div>
      <ErrorBox message={error} />

      <div className="section-head">
        <h2>Proveedores</h2>
        <label className="inline">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Mostrar inactivos
        </label>
        <button className="primary" onClick={() => setEditing('new')}>
          + Nuevo proveedor
        </button>
      </div>
      {shownSuppliers.length === 0 ? (
        <p className="muted">Todavía no hay proveedores.</p>
      ) : (
        <ul className="list">
          {shownSuppliers.map((s) => (
            <li key={s.id} className={s.is_active ? '' : 'inactive'}>
              <div>
                <strong>{s.name}</strong>
                {!s.is_active && <span className="pill">Inactivo</span>}
                <div className="muted small">{[s.contact, s.notes].filter(Boolean).join(' · ')}</div>
              </div>
              <div className="row-actions">
                <button onClick={() => setEditing(s)}>Editar</button>
                <button onClick={() => toggleSupplier(s)}>{s.is_active ? 'Desactivar' : 'Activar'}</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="section-head">
        <h2>Categorías</h2>
      </div>
      <form className="inline-form" onSubmit={addCategory}>
        <select value={catKind} onChange={(e) => setCatKind(e.target.value as Category['kind'])}>
          {(Object.keys(KIND_LABEL) as Category['kind'][]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <input placeholder="Nombre de la categoría" value={catName} onChange={(e) => setCatName(e.target.value)} />
        <button className="primary">Agregar</button>
      </form>
      {(Object.keys(KIND_LABEL) as Category['kind'][]).map((k) => {
        const rows = categories.filter((c) => c.kind === k)
        if (rows.length === 0) return null
        return (
          <div key={k} className="cat-group">
            <h3>{KIND_LABEL[k]}</h3>
            <ul className="list compact">
              {rows.map((c) => (
                <li key={c.id} className={c.is_active ? '' : 'inactive'}>
                  <span>
                    {c.name}
                    {!c.is_active && <span className="pill">Inactiva</span>}
                  </span>
                  <button onClick={() => toggleCategory(c)}>{c.is_active ? 'Desactivar' : 'Activar'}</button>
                </li>
              ))}
            </ul>
          </div>
        )
      })}

      {editing !== null && (
        <SupplierForm
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            load()
          }}
        />
      )}
    </div>
  )
}
