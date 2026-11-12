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
  return (
    <div className="modal-back" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
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
