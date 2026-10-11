import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/* Dragging a conversation onto a folder. Pointer events rather than HTML5
   drag and drop: the desktop window's own file drop handling swallows HTML5
   drag events on Windows, and this way the row, the floating label and the
   lit folder are all ours. A drop target is any element with
   `data-drop-folder`: a folder's id, or "" for "in no folder". The menu's
   "Move to folder" is the keyboard's way to the same thing. */

export interface RowDrag {
  id: string;
  title: string;
  x: number;
  y: number;
  /** The folder under the pointer ("" for none), or undefined off any target. */
  over: string | undefined;
}

const THRESHOLD = 6;

function targetAt(x: number, y: number): string | undefined {
  const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-folder]");
  return hit ? (hit.dataset.dropFolder ?? "") : undefined;
}

export function useRowDrag(onDrop: (id: string, folderId: string | null) => void) {
  const [drag, setDrag] = useState<RowDrag | null>(null);
  /** A drag ended on the row it began on: its click must not open it. */
  const swallowClick = useRef(false);
  const cleanup = useRef<(() => void) | null>(null);
  const dropRef = useRef(onDrop);
  useEffect(() => {
    dropRef.current = onDrop;
  }, [onDrop]);
  useEffect(() => () => cleanup.current?.(), []);

  const begin = (event: ReactPointerEvent, id: string, title: string) => {
    swallowClick.current = false;
    // Primary button only; a pen or touch reports 0 too.
    if (event.button > 0) return;
    cleanup.current?.();
    const sx = event.clientX;
    const sy = event.clientY;
    let moving = false;
    let over: string | undefined;

    const move = (ev: PointerEvent) => {
      if (!moving) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < THRESHOLD) return;
        moving = true;
        document.body.dataset.rowDrag = "true";
      }
      over = targetAt(ev.clientX, ev.clientY);
      setDrag({ id, title, x: ev.clientX, y: ev.clientY, over });
    };
    const finish = (drop: boolean) => {
      const was = moving;
      stop();
      if (!was) return;
      swallowClick.current = true;
      if (drop && over !== undefined) dropRef.current(id, over || null);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const key = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && moving) {
        ev.preventDefault();
        finish(false);
      }
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      delete document.body.dataset.rowDrag;
      cleanup.current = null;
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
    cleanup.current = stop;
  };

  /** For the row's click handler: true once after a drag, which it eats. */
  const consumeClick = () => {
    const swallow = swallowClick.current;
    swallowClick.current = false;
    return swallow;
  };

  return { drag, begin, consumeClick };
}
