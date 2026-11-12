import Decimal from 'decimal.js'

export const todayMX = (): string =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })

// La fecha 2000-01-01 es el marcador de "desde el inicio" de los valores iniciales.
export const displayDate = (d: string): string => (d === '2000-01-01' ? 'Desde el inicio' : d)

export function money(v: number | string | null | undefined, digits = 2): string {
  if (v === null || v === undefined || v === '') return '—'
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number(v))
}

export function pct(v: number | string | null | undefined): string {
  if (v === null || v === undefined) return '—'
  return new Decimal(String(v)).times(100).toDecimalPlaces(2).toString() + '%'
}

// "30" (porcentaje que escribe la persona) -> "0.300000" (fracción que guarda la base de datos)
export function pctToFraction(s: string): string {
  return new Decimal(s.trim() === '' ? '0' : s).div(100).toFixed(6)
}

export function fractionToPct(v: number | string): string {
  return new Decimal(String(v)).times(100).toDecimalPlaces(4).toString()
}

export function isPositiveNumber(s: string): boolean {
  try {
    return new Decimal(s).gt(0)
  } catch {
    return false
  }
}

export function isNonNegativeNumber(s: string): boolean {
  try {
    return new Decimal(s).gte(0)
  } catch {
    return false
  }
}

// Vista previa del costo por unidad base (el cálculo oficial lo hace la base de datos).
export function costPerUnitPreview(price: string, units: string): string {
  try {
    const u = new Decimal(units)
    if (u.lte(0)) return '—'
    return money(new Decimal(price).div(u).toFixed(4), 4)
  } catch {
    return '—'
  }
}

export function friendlyError(message: string): string {
  const m = message.toLowerCase()
  if (m.includes('duplicate key') && m.includes('items_unique_presentation'))
    return 'Ya existe un insumo igual (mismo nombre, marca, color y presentación).'
  if (m.includes('duplicate key') && m.includes('suppliers_name_unique'))
    return 'Ya existe un proveedor con ese nombre.'
  if (m.includes('duplicate key') && m.includes('categories_kind_name_unique'))
    return 'Ya existe una categoría con ese nombre.'
  if (m.includes('duplicate key') && m.includes('business_settings'))
    return 'Ya hay una configuración con esa fecha de inicio. Elige otra fecha.'
  if (m.includes('duplicate key') && m.includes('payment_method_rates'))
    return 'Ya hay una comisión con esa fecha de inicio para ese método. Elige otra fecha.'
  if (m.includes('duplicate key')) return 'Ese registro ya existe.'
  if (m.includes('row-level security') || m.includes('permission denied'))
    return 'No tienes permiso para hacer esto.'
  if (m.includes('failed to fetch') || m.includes('network'))
    return 'No hay conexión con el servidor. Revisa tu internet.'
  return message
}
