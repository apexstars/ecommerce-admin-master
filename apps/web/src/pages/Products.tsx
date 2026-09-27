import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useBulkProducts, useCategories, useProducts } from '../api/hooks';
import { Badge, Dialog, ErrorState, FilterPills, PageHeader, Pagination, SearchInput, Spinner, StockIndicator, Thumb } from '../components/ui';
import { useAuth } from '../lib/auth';
import { money } from '../lib/format';
import { useToast } from '../lib/toast';

function SelectAll({ checked, indeterminate, onChange }: { checked: boolean; indeterminate: boolean; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return <input ref={ref} type="checkbox" aria-label="Select all products on this page" checked={checked} onChange={onChange} />;
}

export function ProductsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const categoryId = params.get('category') ?? undefined;
  const stock = (params.get('stock') as 'low' | 'out' | null) ?? undefined;
  const search = params.get('q') ?? '';
  const page = Number(params.get('page') ?? 1);

  const update = useCallback(
    (next: Record<string, string | number | undefined>) =>
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(next)) {
            if (v === undefined || v === '' || (k === 'page' && v === 1)) p.delete(k);
            else p.set(k, String(v));
          }
          return p;
        },
        { replace: true },
      ),
    [setParams],
  );
  const onSearch = useCallback((q: string) => update({ q, page: 1 }), [update]);

  const categories = useCategories();
  const { data, error, isPending, isFetching } = useProducts({ categoryId, search, stock, page });
  const bulk = useBulkProducts();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Selection is per-view: clear it whenever the visible set changes.
  useEffect(() => setSelected(new Set()), [categoryId, stock, search, page]);

  const ids = data?.items.map((p) => p.id) ?? [];
  const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(ids));
  const canBulk = can('products:edit') || can('products:delete');

  const setStatus = (status: 'active' | 'draft') =>
    bulk.setStatus.mutate(
      { ids: [...selected], status },
      {
        onSuccess: (r) => {
          toast(`${r.updated} product${r.updated === 1 ? '' : 's'} set to ${status}`);
          setSelected(new Set());
        },
        onError: (e) => toast(e.message, 'error'),
      },
    );

  const remove = () =>
    bulk.remove.mutate([...selected], {
      onSuccess: (r) => {
        toast(`${r.deleted} product${r.deleted === 1 ? '' : 's'} deleted`);
        setSelected(new Set());
        setConfirmDelete(false);
      },
      onError: (e) => toast(e.message, 'error'),
    });

  const colSpan = canBulk ? 7 : 6;

  return (
    <>
      <PageHeader title="Products" subtitle="Your catalog, stock levels and publishing status." />
      <section className="card">
        <div className="toolbar">
          <FilterPills
            label="Filter by category"
            value={categoryId ?? 'all'}
            onChange={(c) => update({ category: c === 'all' ? undefined : c, page: 1 })}
            options={[
              { value: 'all', label: 'All' },
              ...(categories.data ?? []).map((c) => ({ value: c.id, label: c.name, count: c.productCount })),
            ]}
          />
          <div className="toolbar-right">
            <div className="select-wrap">
              <label htmlFor="stock-filter" className="sr-only">
                Stock level
              </label>
              <select id="stock-filter" value={stock ?? ''} onChange={(e) => update({ stock: e.target.value || undefined, page: 1 })}>
                <option value="">Any stock level</option>
                <option value="low">Low stock</option>
                <option value="out">Out of stock</option>
              </select>
            </div>
            <SearchInput label="Search products" placeholder="Name or SKU" value={search} onChange={onSearch} />
          </div>
        </div>

        {selected.size > 0 && (
          <div className="bulk-bar" role="region" aria-label="Bulk actions">
            <span className="strong">{selected.size} selected</span>
            {can('products:edit') && (
              <>
                <button type="button" className="btn btn-secondary btn-sm" disabled={bulk.setStatus.isPending} onClick={() => setStatus('active')}>
                  Set active
                </button>
                <button type="button" className="btn btn-secondary btn-sm" disabled={bulk.setStatus.isPending} onClick={() => setStatus('draft')}>
                  Set draft
                </button>
              </>
            )}
            {can('products:delete') && (
              <button type="button" className="btn btn-secondary btn-sm btn-danger-text" onClick={() => setConfirmDelete(true)}>
                Delete
              </button>
            )}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>
              Clear selection
            </button>
          </div>
        )}

        {isPending ? (
          <Spinner />
        ) : error ? (
          <ErrorState error={error} />
        ) : (
          <>
            <div className="table-wrap table-wrap-tall" aria-busy={isFetching}>
              <table className="table">
                <caption className="sr-only">
                  Products. Stock under {data.lowStockThreshold} units is flagged as low.
                </caption>
                <thead>
                  <tr>
                    {canBulk && (
                      <th scope="col" className="check-col">
                        <SelectAll checked={allSelected} indeterminate={selected.size > 0 && !allSelected} onChange={toggleAll} />
                      </th>
                    )}
                    <th scope="col">Product</th>
                    <th scope="col">SKU</th>
                    <th scope="col">Category</th>
                    <th scope="col" className="num">
                      Price
                    </th>
                    <th scope="col">Stock</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.length === 0 && (
                    <tr>
                      <td colSpan={colSpan} className="empty-cell">
                        No products match these filters.
                      </td>
                    </tr>
                  )}
                  {data.items.map((p) => (
                    <tr key={p.id} className={selected.has(p.id) ? 'is-selected' : undefined}>
                      {canBulk && (
                        <td className="check-col">
                          <input type="checkbox" aria-label={`Select ${p.name}`} checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                        </td>
                      )}
                      <td>
                        <div className="product-cell">
                          <Thumb url={p.image?.url} alt={p.image?.alt || p.name} />
                          <div className="cell-stack">
                            <span className="strong">{p.name}</span>
                            <span className="muted small">
                              {p.variantCount} variant{p.variantCount === 1 ? '' : 's'}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td className="mono small">{p.sku}</td>
                      <td>{p.category.name}</td>
                      <td className="num">{money(p.priceCents)}</td>
                      <td>
                        <StockIndicator qty={p.totalStock} level={p.stockLevel} />
                        {p.stockLevel === 'ok' && p.lowVariantCount > 0 && (
                          <span className="variant-warn">
                            {p.lowVariantCount} variant{p.lowVariantCount === 1 ? '' : 's'} low or out
                          </span>
                        )}
                      </td>
                      <td>
                        <Badge tone={p.status === 'active' ? 'success' : 'neutral'}>{p.status === 'active' ? 'Active' : 'Draft'}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => update({ page: p })} />
          </>
        )}
      </section>

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${selected.size} product${selected.size === 1 ? '' : 's'}?`}
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-danger" disabled={bulk.remove.isPending} onClick={remove}>
              {bulk.remove.isPending ? 'Deleting…' : 'Delete'}
            </button>
          </>
        }
      >
        <p className="muted">
          This removes the products and their variants from the catalog. Past orders keep their line items. Consider setting them to
          draft instead if you might sell them again.
        </p>
      </Dialog>
    </>
  );
}
