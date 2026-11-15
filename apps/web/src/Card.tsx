import { useState, type ReactNode } from 'react';

interface Props<T> { id: string; item: T | undefined; label(t: T): string; onClose(): void; children(t: T): ReactNode }

/** A detail panel beside a list. When `item` goes away it keeps showing the last one until its exit animation ends. */
export function Card<T>({ id, item, label, onClose, children }: Props<T>) {
  const [last, setLast] = useState(item);
  if (item !== undefined && item !== last) setLast(item);
  const shown = item ?? last;
  if (shown === undefined) return null;
  const leaving = item === undefined;
  return (
    <section className={`glass panel card ${leaving ? 'leaving' : ''}`} id={id} aria-label={label(shown)} inert={leaving}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      onAnimationEnd={(e) => leaving && e.target === e.currentTarget && setLast(undefined)}>
      <button className="close" onClick={onClose} aria-label="Close" title="Close">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
      {children(shown)}
    </section>
  );
}
