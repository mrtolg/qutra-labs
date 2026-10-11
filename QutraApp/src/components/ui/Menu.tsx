import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export interface MenuItemDef {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

interface MenuProps {
  anchorEl: HTMLElement | null;
  items: (MenuItemDef | "separator")[];
  onClose: () => void;
  ariaLabel: string;
}

/** Portal-rendered dropdown menu; never clipped by scroll containers. */
export function Menu({ anchorEl, items, onClose, ariaLabel }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);

  useLayoutEffect(() => {
    if (!anchorEl) return;
    const rect = anchorEl.getBoundingClientRect();
    const menuW = 200;
    const left = Math.min(rect.left, window.innerWidth - menuW - 8);
    let top = rect.bottom + 4;
    // flip up if near the bottom
    const estH = items.length * 32 + 8;
    if (top + estH > window.innerHeight - 8) {
      top = Math.max(8, rect.top - estH - 4);
    }
    setPos({ top, left });
  }, [anchorEl, items.length]);

  useEffect(() => {
    if (!anchorEl) return;
    const onDocClick = (e: MouseEvent) => {
      if (
        ref.current &&
        !ref.current.contains(e.target as Node) &&
        e.target !== anchorEl
      ) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      const actionable = items.filter(
        (i): i is MenuItemDef => i !== "separator" && !i.disabled,
      );
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        anchorEl.focus();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusIndex((i) => (i + 1) % actionable.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusIndex((i) => (i - 1 + actionable.length) % actionable.length);
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        actionable[focusIndex]?.onSelect();
        onClose();
      } else if (e.key === "Tab") {
        onClose();
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [anchorEl, items, focusIndex, onClose]);

  useEffect(() => {
    const actionableEls =
      ref.current?.querySelectorAll<HTMLButtonElement>(
        ".menu-item:not(:disabled)",
      ) ?? [];
    actionableEls[focusIndex]?.focus();
  }, [focusIndex, pos]);

  if (!anchorEl || !pos) return null;

  let actionableIdx = -1;
  return createPortal(
    <div
      ref={ref}
      className="menu"
      role="menu"
      aria-label={ariaLabel}
      style={{ top: pos.top, left: pos.left }}
    >
      {items.map((item, i) => {
        if (item === "separator") {
          return <div key={`sep-${i}`} className="menu-sep" role="separator" />;
        }
        if (!item.disabled) actionableIdx++;
        return (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className={`menu-item${item.danger ? " menu-item--danger" : ""}`}
            disabled={item.disabled}
            tabIndex={actionableIdx === focusIndex ? 0 : -1}
            onClick={() => {
              item.onSelect();
              onClose();
            }}
          >
            {item.icon}
            {item.label}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
