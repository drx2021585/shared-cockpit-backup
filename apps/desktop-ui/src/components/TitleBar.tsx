import { useEffect, useState } from "react";

/**
 * Barra de título custom estilo macOS (3 puntos de color a la izquierda:
 * cerrar/minimizar/maximizar) en vez de los controles nativos de Windows
 * (X / cuadrado / guion) — la ventana de Electron se crea con `frame: false`
 * (ver electron/main.cjs), así que esta barra ES la única forma de mover,
 * minimizar, maximizar o cerrar la ventana.
 *
 * No se renderiza en el build web puro (sin Electron): ahí el navegador ya
 * pone su propia barra, y no existe `window.weconnectWindow`.
 */
export function TitleBar() {
  const win = window.weconnectWindow;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!win) return;
    win.isMaximized().then(setMaximized);
    return win.onStateChange((payload) => setMaximized(payload.maximized));
  }, [win]);

  if (!win) return null;

  return (
    <div className="titlebar">
      <div className="titlebar-dots">
        <button
          className="titlebar-dot titlebar-dot-close"
          onClick={() => win.close()}
          aria-label="Close"
        >
          <span className="titlebar-dot-glyph">✕</span>
        </button>
        <button
          className="titlebar-dot titlebar-dot-minimize"
          onClick={() => win.minimize()}
          aria-label="Minimize"
        >
          <span className="titlebar-dot-glyph">−</span>
        </button>
        <button
          className="titlebar-dot titlebar-dot-maximize"
          onClick={() => win.toggleMaximize()}
          aria-label={maximized ? "Restore" : "Maximize"}
        >
          <span className="titlebar-dot-glyph">{maximized ? "⤢" : "+"}</span>
        </button>
      </div>
      <div className="titlebar-drag-region" />
    </div>
  );
}
