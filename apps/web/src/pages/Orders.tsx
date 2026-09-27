import { useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useOrders } from '../api/hooks';
import type { OrderFilter } from '../api/types';
import { ErrorState, FilterPills, FulfillmentBadge, PageHeader, Pagination, PaymentBadge, SearchInput, Spinner } from '../components/ui';
import { useAuth } from '../lib/auth';
import { formatDateTime, money } from '../lib/format';

const FILTERS: { value: OrderFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'paid', label: 'Paid' },
  { value: 'fulfilled', label: 'Fulfilled' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'refunded', label: 'Refunded' },
];

export function OrdersPage() {
  const { can } = useAuth();
  // Filters live in the URL so back/forward and shared links keep the view.
  const [params, setParams] = useSearchParams();
  const filter = (params.get('filter') as OrderFilter | null) ?? 'all';
  const search = params.get('q') ?? '';
  const page = Number(params.get('page') ?? 1);

  const update = useCallback(
    (next: Record<string, string | number | undefined>) =>
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(next)) {
            if (v === undefined || v === '' || (k === 'filter' && v === 'all') || (k === 'page' && v === 1)) p.delete(k);
            else p.set(k, String(v));
          }
          return p;
        },
        { replace: true },
      ),
    [setParams],
  );
  const onSearch = useCallback((q: string) => update({ q, page: 1 }), [update]);

  const { data, error, isPending, isFetching } = useOrders({ filter, search, page });

  return (
    <>
      <PageHeader title="Orders" subtitle="Track payments and fulfillment across every order." />
      <section className="card">
        <div className="toolbar">
          <FilterPills
            label="Filter by status"
            value={filter}
            onChange={(f) => update({ filter: f, page: 1 })}
            options={FILTERS.map((f) => ({ ...f, count: data?.counts[f.value] }))}
          />
          <SearchInput label="Search orders" placeholder="Order # or customer" value={search} onChange={onSearch} />
        </div>

        {isPending ? (
          <Spinner />
        ) : error ? (
          <ErrorState error={error} />
        ) : (
          <>
            <div className="table-wrap table-wrap-tall" aria-busy={isFetching}>
              <table className="table">
                <caption className="sr-only">Orders, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">Order</th>
                    <th scope="col">Customer</th>
                    <th scope="col">Date</th>
                    <th scope="col" className="num">
                      Items
                    </th>
                    <th scope="col">Payment</th>
                    <th scope="col">Fulfillment</th>
                    <th scope="col" className="num">
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.length === 0 && (
                    <tr>
                      <td colSpan={7} className="empty-cell">
                        No orders match these filters.
                      </td>
                    </tr>
                  )}
                  {data.items.map((o) => (
                    <tr key={o.id}>
                      <td>
                        <Link to={`/orders/${o.id}`} className="link-strong">
                          #{o.number}
                        </Link>
                      </td>
                      <td>
                        <div className="cell-stack">
                          {o.customer && can('customers:view') ? (
                            <Link to={`/customers/${o.customer.id}`} className="link-plain">
                              {o.customer.name}
                            </Link>
                          ) : (
                            <span>{o.customer?.name ?? 'Unknown customer'}</span>
                          )}
                          <span className="muted small">{o.customer?.email}</span>
                        </div>
                      </td>
                      <td className="muted nowrap">{formatDateTime(o.placedAt)}</td>
                      <td className="num">{o.itemCount}</td>
                      <td>
                        <PaymentBadge status={o.status} />
                      </td>
                      <td>
                        <FulfillmentBadge status={o.fulfillmentStatus} />
                      </td>
                      <td className="num strong">{money(o.totalCents, o.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => update({ page: p })} />
          </>
        )}
      </section>
    </>
  );
}
