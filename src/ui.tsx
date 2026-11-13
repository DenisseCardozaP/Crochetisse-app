import { useRef } from 'react'
import type { ReactNode } from 'react'

export function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="label">{props.label}</span>
      {props.children}
      {props.hint && <span className="hint">{props.hint}</span>}
    </label>
  )
}

export function ErrorBox({ message }: { message: string }) {
  if (!message) return null
  return <p className="error-box">{message}</p>
}

export function OkBox({ message }: { message: string }) {
  if (!message) return null
  return <p className="ok-box">{message}</p>
}

export function Modal(props: { title: string; onClose: () => void; children: ReactNode }) {
  const downOnBackdrop = useRef(false)
  return (
    // Solo se cierra si el clic empezó Y terminó fuera de la ventana (arrastrar para seleccionar texto no la cierra)
    <div
      className="modal-back"
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && downOnBackdrop.current) props.onClose()
        downOnBackdrop.current = false
      }}
    >
      <div className="modal">
        <div className="modal-head">
          <h2>{props.title}</h2>
          <button type="button" onClick={props.onClose} aria-label="Cerrar">
            ✕
          </button>
        </div>
        {props.children}
      </div>
    </div>
  )
}
