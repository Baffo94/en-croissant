import type { ReactNode } from "react";
import { useBackHandler } from "../back";
import { Icon } from "./Icon";

/**
 * Panel sliding up from the bottom, used to edit a comment, a flag or the ideas: the
 * screen underneath keeps its shape while you type.
 */
export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useBackHandler(onClose);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grab" />
        <div className="sheet-head">
          <span className="sheet-title">{title}</span>
          <button type="button" className="icon-btn ghost" aria-label="Chiudi" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
