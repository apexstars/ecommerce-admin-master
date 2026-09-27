import { AlertTriangle, ArrowDownRight, ArrowUpRight, Minus, XCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useDashboard } from '../api/hooks';
import type { Stat } from '../api/types';
import { ErrorState, FulfillmentBadge, NoAccess, PageHeader, PaymentBadge, Spinner } from '../components/ui';
import { useAuth } from '../lib/auth';
import { formatDateTime, money, percent } from '../lib/format';

function Delta({ stat }: { stat: Stat }) {
  if (stat.change === null) return <span className="delta delta-flat">No data yesterday</span>;
  const flat = Math.abs(stat.change) < 0.005;
  const up = stat.change > 0;
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`delta ${flat ? 'delta-flat' : up ? 'delta-up' : 'delta-down'}`}>
      <Icon size={14} aria-hidden />
      <span className="sr-only">{flat ? 'Unchanged' : up ? 'Up' : 'Down'}</span>
      {flat ? '0%' : percent(stat.change)}
    </span>
  );
}

function StatCard({ label, stat, format }: { label: string; stat: Stat; format: (n: number) => string }) {
  return (
    <section className="card stat-card" aria-label={label}>
      <h2 className="stat-label">{label}</h2>
      <p className="stat-value">{format(stat.value)}</p>
      <p className="stat-foot">
        <Delta stat={stat} /> <span className="muted">vs. {format(stat.previous)} this time yesterday</span>
      </p>
    </section>
  );
}

export function DashboardPage() {
  const { me, can } = useAuth();
  const allowed = can('reports:view') && can('orders:view') && can('inventory:view');
  const { data, error, isPending } = useDashboard(allowed);
  const firstName = me?.name.split(' ')[0];

  if (!allowed) {
    return (
      <>
        <PageHeader title={`Welcome, ${firstName}`} subtitle="Use the navigation to get to your work." />
        <NoAccess what="the store dashboard (it needs reports, orders and inventory access)" />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Dashboard" subtitle={`Good to see you, ${firstName}. Here's today so far.`} />
      {isPending ? (
        <Spinner />
      ) : error ? (
        <ErrorState error={error} />
      ) : (
        <>
          <div className="stat-grid">
            <StatCard label="Revenue today" stat={data.stats.revenue} format={(n) => money(n)} />
            <StatCard label="Orders today" stat={data.stats.orders} format={(n) => n.toLocaleString()} />
            <StatCard label="Average order value" stat={data.stats.aov} format={(n) => money(n)} />
          </div>

          <div className="dashboard-grid">
            <section className="card" aria-labelledby="recent-orders">
              <div className="card-header">
                <h2 id="recent-orders">Recent orders</h2>
                <Link to="/orders" className="link">
                  View all
                </Link>
              </div>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Order</th>
                      <th scope="col">Customer</th>
                      <th scope="col">Placed</th>
                      <th scope="col">Payment</th>
                      <th scope="col">Fulfillment</th>
                      <th scope="col" className="num">
                        Total
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentOrders.map((o) => (
                      <tr key={o.id}>
                        <td>
                          <Link to={`/orders/${o.id}`} className="link-strong">
                            #{o.number}
                          </Link>
                        </td>
                        <td>{o.customer?.name ?? '—'}</td>
                        <td className="muted nowrap">{formatDateTime(o.placedAt)}</td>
                        <td>
                          <PaymentBadge status={o.status} />
                        </td>
                        <td>
                          <FulfillmentBadge status={o.fulfillmentStatus} />
                        </td>
                        <td className="num">{money(o.totalCents, o.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="card" aria-labelledby="low-stock">
              <div className="card-header">
                <h2 id="low-stock">Low stock</h2>
                <Link to="/products" className="link">
                  Products
                </Link>
              </div>
              {data.lowStock.items.length === 0 ? (
                <p className="empty-state">Everything is above {data.lowStock.threshold} units.</p>
              ) : (
                <ul className="stock-list">
                  {data.lowStock.items.map((v) => (
                    <li key={v.variantId} className={`stock-row stock-row-${v.stockLevel}`}>
                      {v.stockLevel === 'out' ? <XCircle size={18} aria-hidden /> : <AlertTriangle size={18} aria-hidden />}
                      <div className="stock-row-text">
                        <span className="stock-row-name">{v.productName}</span>
                        <span className="muted small">
                          {v.label} · {v.sku}
                        </span>
                      </div>
                      <span className="stock-row-qty">
                        {v.stockLevel === 'out' ? 'Out of stock' : `${v.stockQty} left`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="card-foot muted small">Showing active variants under {data.lowStock.threshold} units.</p>
            </section>
          </div>
        </>
      )}
    </>
  );
}
