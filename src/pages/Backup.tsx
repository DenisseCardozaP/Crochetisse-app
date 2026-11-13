import { useState } from 'react'
import { supabase } from '../supabase'
import { friendlyError, todayMX } from '../format'
import { ErrorBox, OkBox } from '../ui'

export const BACKUP_KEY = 'amigurumis_last_backup'
export function lastBackup(): string | null {
  try {
    return localStorage.getItem(BACKUP_KEY)
  } catch {
    return null
  }
}

export default function Backup() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')
  const [counts, setCounts] = useState<[string, number][]>([])
  const [last, setLast] = useState(lastBackup())

  async function download() {
    setBusy(true)
    setError('')
    setOk('')
    const { data, error } = await supabase.rpc('export_backup')
    setBusy(false)
    if (error) return setError(friendlyError(error.message))
    const day = todayMX()
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `respaldo-amigurumis-${day}.json`
    a.click()
    URL.revokeObjectURL(a.href)
    try {
      localStorage.setItem(BACKUP_KEY, day)
    } catch {
      /* sin almacenamiento: no pasa nada */
    }
    setLast(day)
    setCounts(Object.entries((data as { counts: Record<string, number> }).counts).filter(([, n]) => n > 0))
    setOk('Respaldo descargado. Guárdalo en un lugar seguro (tu nube o una USB), no solo en este dispositivo.')
  }

  const days = last ? Math.round((Date.parse(todayMX()) - Date.parse(last)) / 86400000) : null

  return (
    <div>
      <div className="section-head">
        <h2>Respaldo</h2>
        <button className="primary" disabled={busy} onClick={download}>
          {busy ? 'Preparando...' : 'Descargar respaldo'}
        </button>
      </div>
      <p className="muted">
        Un archivo con TODA la información del negocio: insumos, productos, compras, ventas, pedidos, gastos, retiros y bitácora. Solo la dueña puede descargarlo.
      </p>
      <p>
        Último respaldo en este dispositivo: <b>{last ?? 'nunca'}</b>
        {days !== null && days > 7 && <span className="pill warn">hace {days} días: toca respaldar</span>}
      </p>
      <ErrorBox message={error} />
      <OkBox message={ok} />
      {counts.length > 0 && (
        <p className="muted small">Incluye: {counts.map(([t, n]) => `${t} (${n})`).join(', ')}.</p>
      )}

      <div className="panel-card" style={{ marginTop: 18 }}>
        <h3>Antes de empezar a usarlo de verdad</h3>
        <ol style={{ lineHeight: 1.8 }}>
          <li>
            <b>Prueba todo con datos de prueba</b> (ya lo hiciste en gran parte).
          </li>
          <li>
            <b>Descarga un respaldo</b> aquí, por si quieres conservar algo de las pruebas.
          </li>
          <li>
            <b>Borra los datos de prueba:</b> en Supabase abre SQL Editor, pega el archivo <code>supabase/reset_datos_de_prueba.sql</code> y ejecútalo. Conserva tu configuración, formas de pago, proveedores, categorías y tu estambre de venta con su existencia inicial.
          </li>
          <li>
            <b>Carga tus insumos reales</b> en Insumos, con el botón "Importar CSV" (o uno por uno), y registra tus compras.
          </li>
          <li>
            <b>Respalda cada semana.</b> Esta pantalla te avisa cuando pasen más de 7 días.
          </li>
        </ol>
        <p className="hint">
          Este respaldo es para guardar y consultar tu información. Si alguna vez hay que restaurarlo, se hace con ayuda (el archivo trae cada tabla completa).
        </p>
      </div>
    </div>
  )
}
