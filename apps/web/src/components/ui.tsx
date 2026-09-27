import { AlertTriangle, ChevronLeft, ChevronRight, Lock, Search, XCircle } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { FulfillmentStatus, OrderStatus, StockLevel } from '../api/types';
import { capitalize, initials } from '../lib/format';

// ── Badges ───────────────────────────────────────────────────────────────────

export type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'info';

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`badge badge-${tone}`}>
      <span className="badge-dot" aria-hidden />
      {children}
    </span>
  );
}

const PAYMENT_TONE: Record<OrderStatus, Tone> = { pending: 'warning', paid: 'success', refunded: 'neutral', cancelled: 'danger' };
const FULFILLMENT_TONE: Record<FulfillmentStatus, Tone> = { unfulfilled: 'neutral', preparing: 'info', shipped: 'info', delivered: 'success' };

export const PaymentBadge = ({ status }: { status: OrderStatus }) => <Badge tone={PAYMENT_TONE[status]}>{capitalize(status)}</Badge>;
export const FulfillmentBadge = ({ status }: { status: FulfillmentStatus }) => (
  <Badge tone={FULFILLMENT_TONE[status]}>{capitalize(status)}</Badge>
);

/** Stock warnings carry an icon + text, never color alone. */
export function StockIndicator({ qty, level }: { qty: number; level: StockLevel }) {
  return (
    <span className={`stock stock-${level}`}>
      <span className="num">{qty}</span>
      {level === 'low' && (
        <span className="stock-flag">
          <AlertTriangle size={13} aria-hidden /> Low
        </span>
      )}
      {level === 'out' && (
        <span className="stock-flag">
          <XCircle size={13} aria-hidden /> Out of stock
        </span>
      )}
    </span>
  );
}

// ── Layout bits ──────────────────────────────────────────────────────────────

export function PageHeader({ title, subtitle, actions, eyebrow }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        {eyebrow}
        <h1>{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Avatar({ name, url, size = 32 }: { name: string; url?: string | null; size?: number }) {
  if (url) return <img className="avatar" src={url} alt="" width={size} height={size} />;
  // Stable hue per person so avatars are distinguishable without meaning anything.
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return (
    <span className="avatar" style={{ width: size, height: size, background: `hsl(${hue} 45% 88%)`, color: `hsl(${hue} 45% 28%)` }} aria-hidden>
      {initials(name)}
    </span>
  );
}

export function Thumb({ url, alt }: { url: string | null | undefined; alt: string }) {
  return url ? <img className="thumb" src={url} alt={alt} loading="lazy" /> : <span className="thumb thumb-empty" aria-hidden>{initials(alt)}</span>;
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="spinner-wrap" role="status">
      <span className="spinner" aria-hidden />
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function ErrorState({ error }: { error: unknown }) {
  return (
    <div className="empty-state" role="alert">
      <XCircle size={20} aria-hidden />
      <p>{error instanceof Error ? error.message : 'Something went wrong'}</p>
    </div>
  );
}

export function NoAccess({ what }: { what: string }) {
  return (
    <div className="card empty-state">
      <Lock size={20} aria-hidden />
      <p>
        Your role doesn't include access to {what}. Ask a Super Admin if you need it.
      </p>
    </div>
  );
}

// ── Controls ─────────────────────────────────────────────────────────────────

export function FilterPills<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="pills" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className="pill" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
          {o.count !== undefined && <span className="pill-count">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Debounced search box with a real (visually hidden) label. */
export function SearchInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (draft === value) return;
    const t = setTimeout(() => onChange(draft), 300);
    return () => clearTimeout(t);
  }, [draft, value, onChange]);
  return (
    <div className="search">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Search size={16} aria-hidden className="search-icon" />
      <input id={id} type="search" value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} />
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(total, page * pageSize);
  return (
    <nav className="pagination" aria-label="Pagination">
      <span className="muted">
        Showing <strong>{from}</strong>–<strong>{to}</strong> of <strong>{total}</strong>
      </span>
      <div className="pagination-buttons">
        <button type="button" className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft size={16} aria-hidden /> Previous
        </button>
        <span className="muted">
          Page {page} of {pages}
        </span>
        <button type="button" className="btn btn-secondary btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next <ChevronRight size={16} aria-hidden />
        </button>
      </div>
    </nav>
  );
}

/** Native <dialog> modal: focus trapping, Esc and inert background for free. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={`dialog${wide ? ' dialog-wide' : ''}`} aria-labelledby={titleId} onClose={onClose}>
      <h2 id={titleId}>{title}</h2>
      <div className="dialog-body">{children}</div>
      {footer && <div className="dialog-footer">{footer}</div>}
    </dialog>
  );
}

export function Field({ label, children, hint, error }: { label: string; children: (id: string) => ReactNode; hint?: string; error?: string }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && !error && <p className="field-hint">{hint}</p>}
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}
