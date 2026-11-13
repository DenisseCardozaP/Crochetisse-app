import { useState } from 'react'
import { supabase } from '../supabase'
import { friendlyError, isNonNegativeNumber, isPositiveNumber, todayMX } from '../format'
import { ErrorBox, Modal, OkBox } from '../ui'

interface Existing {
  name: string
  brand: string | null
  color: string | null
  purchase_unit: string
}
interface ParsedRow {
  line: number
  name: string
  kind: 'material' | 'packaging' | 'resale'
  brand: string
  color: string
  purchase_unit: string
  base_unit: string
  units_per_purchase: string
  min_stock: string
  price: string
  stock: string
  errors: string[]
}

const TEMPLATE =
  'nombre,tipo,marca,color,unidad_compra,unidad_base,unidades_por_compra,minimo,precio_compra,existencia\n' +
  'Relleno de fibra,material,,,bolsa,g,1000,500,150,2000\n' +
  'Ojos de seguridad 8 mm,material,,,paquete,pz,100,20,60,100\n' +
  'Bolsa chica,empaque,,,pz,pz,1,20,2.5,100\n'

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')

// Lector de CSV: comillas, comas o punto y coma (como lo guarda Excel en español), saltos de línea dentro de comillas
export function parseCsv(text: string): string[][] {
  const t = text.replace(/^﻿/, '')
  const firstLine = t.split(/\r?\n/)[0] ?? ''
  const sep = (firstLine.match(/;/g) ?? []).length > (firstLine.match(/,/g) ?? []).length ? ';' : ','
  const rows: string[][] = []
  let row: string[] = []
  let cur = ''
  let q = false
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (q) {
      if (c === '"') {
        if (t[i + 1] === '"') {
          cur += '"'
          i++
        } else q = false
      } else cur += c
    } else if (c === '"') q = true
    else if (c === sep) {
      row.push(cur)
      cur = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++
      row.push(cur)
      rows.push(row)
      row = []
      cur = ''
    } else cur += c
  }
  if (cur !== '' || row.length) {
    row.push(cur)
    rows.push(row)
  }
  return rows.filter((r) => r.some((x) => x.trim() !== ''))
}

const KINDS: Record<string, ParsedRow['kind']> = {
  material: 'material',
  empaque: 'packaging',
  packaging: 'packaging',
  venta: 'resale',
  reventa: 'resale',
  resale: 'resale',
}
const ALIASES: Record<string, string> = {
  nombre: 'name',
  tipo: 'kind',
  marca: 'brand',
  color: 'color',
  unidad_compra: 'purchase_unit',
  unidad_de_compra: 'purchase_unit',
  unidad_base: 'base_unit',
  unidad_de_consumo: 'base_unit',
  unidades_por_compra: 'units_per_purchase',
  cantidad_por_unidad_de_compra: 'units_per_purchase',
  minimo: 'min_stock',
  stock_minimo: 'min_stock',
  precio_compra: 'price',
  precio: 'price',
  existencia: 'stock',
}

export default function ImportItems(props: { existing: Existing[]; onDone: () => void; onClose: () => void }) {
  const [rows, setRows] = useState<ParsedRow[] | null>(null)
  const [fileError, setFileError] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  const [failed, setFailed] = useState<string[]>([])

  const keyOf = (n: string, b: string | null, c: string | null, u: string) =>
    [n, b ?? '', c ?? '', u].map((x) => x.trim().toLowerCase()).join('|')

  async function onFile(file: File | undefined) {
    setFileError('')
    setRows(null)
    setResult('')
    setFailed([])
    if (!file) return
    const data = parseCsv(await file.text())
    if (data.length < 2) return setFileError('El archivo está vacío o solo trae los encabezados.')
    const headers = data[0].map((h) => ALIASES[norm(h)] ?? '')
    if (!headers.includes('name') || !headers.includes('kind')) return setFileError('Faltan columnas: como mínimo "nombre" y "tipo". Descarga la plantilla para ver el formato.')
    const seen = new Set(props.existing.map((e) => keyOf(e.name, e.brand, e.color, e.purchase_unit)))
    const out: ParsedRow[] = data.slice(1).map((cells, i) => {
      const g = (k: string) => (cells[headers.indexOf(k)] ?? '').trim()
      const kind = KINDS[norm(g('kind'))]
      const r: ParsedRow = {
        line: i + 2,
        name: g('name'),
        kind: kind ?? 'material',
        brand: g('brand'),
        color: g('color'),
        purchase_unit: g('purchase_unit'),
        base_unit: g('base_unit'),
        units_per_purchase: g('units_per_purchase').replace(',', '.'),
        min_stock: g('min_stock').replace(',', '.'),
        price: g('price').replace(/[$\s]/g, '').replace(',', '.'),
        stock: g('stock').replace(',', '.'),
        errors: [],
      }
      if (!r.name) r.errors.push('falta el nombre')
      if (!kind) r.errors.push('tipo debe ser material, empaque o venta')
      if (!r.purchase_unit) r.errors.push('falta la unidad de compra')
      if (r.kind !== 'resale') {
        if (!r.base_unit) r.errors.push('falta la unidad base')
        if (!isPositiveNumber(r.units_per_purchase)) r.errors.push('unidades por compra debe ser mayor a 0')
      } else {
        r.base_unit = r.purchase_unit
        r.units_per_purchase = '1'
      }
      if (r.min_stock !== '' && !isNonNegativeNumber(r.min_stock)) r.errors.push('mínimo no válido')
      if (r.price !== '' && !isNonNegativeNumber(r.price)) r.errors.push('precio no válido')
      if (r.stock !== '' && !isNonNegativeNumber(r.stock)) r.errors.push('existencia no válida')
      if (r.stock !== '' && Number(r.stock) > 0 && r.price === '') r.errors.push('para cargar existencia hace falta el precio de compra')
      if (r.name && r.purchase_unit) {
        const k = keyOf(r.name, r.brand, r.color, r.purchase_unit)
        if (seen.has(k)) r.errors.push('ya existe (o está repetido en el archivo)')
        seen.add(k)
      }
      return r
    })
    setRows(out)
  }

  const valid = (rows ?? []).filter((r) => r.errors.length === 0)

  async function run() {
    setBusy(true)
    setResult('')
    const bad: string[] = []
    let done = 0
    for (const r of valid) {
      const ins = await supabase
        .from('items')
        .insert({
          name: r.name,
          kind: r.kind,
          brand: r.brand || null,
          color: r.color || null,
          purchase_unit: r.purchase_unit,
          base_unit: r.base_unit,
          units_per_purchase: r.units_per_purchase,
          min_stock: r.min_stock === '' ? 0 : r.min_stock,
          is_consumable: r.kind !== 'resale',
          is_sellable: r.kind === 'resale',
        })
        .select('id')
        .single()
      if (ins.error || !ins.data) {
        bad.push(`Línea ${r.line} (${r.name}): ${friendlyError(ins.error?.message ?? 'no se pudo guardar')}`)
        continue
      }
      const id = (ins.data as { id: string }).id
      if (r.price !== '') {
        const p = await supabase.from('item_price_history').insert({ item_id: id, valid_from: todayMX(), purchase_price: r.price, source: 'manual', note: 'Importado desde CSV' })
        if (p.error) {
          bad.push(`Línea ${r.line} (${r.name}): el insumo se creó pero no su precio: ${friendlyError(p.error.message)}`)
          done++
          continue
        }
      }
      if (r.stock !== '' && Number(r.stock) > 0) {
        const a = await supabase.rpc('adjust_stock', { p_item_id: id, p_delta: r.stock, p_reason: 'Existencia inicial (importación CSV)' })
        if (a.error) bad.push(`Línea ${r.line} (${r.name}): el insumo se creó pero no su existencia: ${friendlyError(a.error.message)}`)
      }
      done++
    }
    setBusy(false)
    setFailed(bad)
    setResult(`Se importaron ${done} insumo(s).`)
    setRows(null)
    props.onDone()
  }

  function downloadTemplate() {
    const blob = new Blob(['﻿' + TEMPLATE], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'plantilla-insumos.csv'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <Modal title="Importar insumos desde CSV" onClose={props.onClose}>
      <p className="muted small">
        Arma tu lista en Excel o Google Sheets y guárdala como CSV. Columnas: nombre, tipo (material, empaque o venta), marca, color, unidad_compra, unidad_base, unidades_por_compra, minimo, precio_compra y existencia (en unidad base). Solo "nombre" y "tipo" son obligatorias; los duplicados se omiten.
      </p>
      <div className="actions left">
        <button onClick={downloadTemplate}>Descargar plantilla</button>
      </div>
      <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} style={{ marginTop: 10 }} />
      <ErrorBox message={fileError} />
      <OkBox message={result} />
      {failed.length > 0 && (
        <ul className="error-box" style={{ paddingLeft: 28 }}>
          {failed.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      )}
      {rows && (
        <>
          <p>
            <b>{valid.length}</b> listos para importar · <b>{rows.length - valid.length}</b> con problemas (se omiten)
          </p>
          <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Línea</th>
                  <th>Insumo</th>
                  <th>Tipo</th>
                  <th>Compra</th>
                  <th>Precio</th>
                  <th>Existencia</th>
                  <th>Revisión</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.line}>
                    <td>{r.line}</td>
                    <td>{[r.name, r.brand, r.color].filter(Boolean).join(' · ')}</td>
                    <td>{r.kind}</td>
                    <td>
                      {r.units_per_purchase} {r.base_unit} / {r.purchase_unit}
                    </td>
                    <td>{r.price}</td>
                    <td>{r.stock}</td>
                    <td>{r.errors.length ? <span style={{ color: 'var(--bad)' }}>{r.errors.join('; ')}</span> : <span className="pill sage">ok</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="actions">
            <button className="primary" disabled={busy || valid.length === 0} onClick={run}>
              {busy ? 'Importando...' : `Importar ${valid.length} insumo(s)`}
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}
