import type { LucideIcon } from "lucide-react";

export function IconButton({ icon: Icon, label, active, onClick, disabled }: { icon: LucideIcon; label: string; active?: boolean; onClick?: () => void; disabled?: boolean }) {
  return (
    <button className={`icon-button${active ? " active" : ""}`} type="button" title={label} aria-label={label} onClick={onClick} disabled={disabled}>
      <Icon size={17} strokeWidth={1.8} />
    </button>
  );
}

