import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { deletePin, usePins, type PinCategory } from '../data/pins';
import { num } from '../data/format';

const labels: Record<PinCategory, string> = {
  project: 'Projects',
  invoice: 'Invoices',
  check: 'Checks',
  'purchase-order': 'Purchase orders',
};

export default function Pinned() {
  const { pins, ready, error } = usePins();
  const [sort, setSort] = useState<'category' | 'newest' | 'title'>('category');
  const shown = useMemo(() => [...pins].sort((a, b) => {
    if (sort === 'newest') return b.createdAt.localeCompare(a.createdAt) || b.id - a.id;
    if (sort === 'title') return a.title.localeCompare(b.title) || a.category.localeCompare(b.category);
    return a.category.localeCompare(b.category) || a.title.localeCompare(b.title);
  }), [pins, sort]);

  return (
    <div className="stack pinned-page">
      <div><div className="accent-rule" /><div className="page-head"><div><h1>Pinned</h1><p className="page-head__sub">Your private shortcuts to projects, invoices, checks and purchase orders.</p></div></div></div>
      <section className="panel">
        <div className="panel__head"><div><h2 className="panel__title">Your pinned items</h2><p className="panel__sub">{ready ? `${num(pins.length)} ${pins.length === 1 ? 'item' : 'items'}` : 'Reading pins…'}</p></div><label className="pinned-sort">Sort by <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="category">Category</option><option value="newest">Newest pinned</option><option value="title">Title</option></select></label></div>
        {error ? <p className="notice notice--error">Could not load your pins: {error.message}</p> : null}
        {!error && ready && shown.length === 0 ? <p className="pinned-empty">Nothing pinned yet. Any project, invoice, check or purchase order can be pinned from the pushpin button in the top corner of its details panel.</p> : null}
        <div className="pinned-list">
          {shown.map((pin) => <div className="pinned-row" key={pin.id}><div><div className="pinned-row__category">{labels[pin.category]}</div><Link to={pin.href} className="pinned-row__title">{pin.title}</Link>{pin.subtitle ? <div className="pinned-row__sub">{pin.subtitle}</div> : null}</div><button type="button" className="btn btn--system btn--sm" onClick={() => void deletePin(pin.category, pin.entityKey)}>Unpin</button></div>)}
        </div>
      </section>
    </div>
  );
}