import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

// Resize a right-docked panel by dragging its LEFT edge.
// Dragging left widens; dragging right narrows. Width is clamped.
export function useResizable(defaultW = 448, min = 320, max = 1000) {
  const [width, setWidth] = useState(defaultW);
  const start = useRef<{ sx: number; ow: number } | null>(null);

  const onPointerDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    start.current = { sx: e.clientX, ow: width };
    const move = (ev: PointerEvent) => {
      if (!start.current) return;
      const next = start.current.ow + (start.current.sx - ev.clientX);
      setWidth(Math.min(max, Math.max(min, next)));
    };
    const up = () => {
      start.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return { width, onPointerDown };
}
