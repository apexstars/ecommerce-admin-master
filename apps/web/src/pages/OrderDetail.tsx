import { ArrowLeft, Ban, Check, CreditCard, MapPin, RotateCcw, Truck, User } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAdvanceFulfillment, useCancelOrder, useOrder, useRefundOrder } from '../api/hooks';
import type { OrderDetail, TimelineStep } from '../api/types';
import { Dialog, ErrorState, Field, FulfillmentBadge, PageHeader, PaymentBadge, Spinner, Thumb } from '../components/ui';
import { useAuth } from '../lib/auth';
import { capitalize, formatDateTime, money } from '../lib/format';
import { useToast } from '../lib/toast';

const NEXT_LABEL = { preparing: 'Start preparing', shipped: 'Mark as shipped', delivered: 'Mark as delivered' } as const;

function Timeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <ol className="timeline">
      {steps.map((s) => (
        <li key={s.key} className={`timeline-step is-${s.state}`} aria-current={s.state === 'current' ? 'step' : undefined}>
          <span className="timeline-dot" aria-hidden>
            {s.state === 'done' && <Check size={14} strokeWidth={3} />}
          </span>
          <span className="timeline-label">{s.label}</span>
          <span className="timeline-time">
            {s.at ? formatDateTime(s.at) : s.state === 'current' ? 'Up next' : s.state === 'skipped' ? 'Skipped' : '—'}
          </span>
          <span className="sr-only">({s.state})</span>
        </li>
      ))}
    </ol>
  );
}

function ReasonDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel,
  danger,
  pending,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  pending: boolean;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Keep order
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            disabled={!reason.trim() || pending}
            onClick={() => onConfirm(reason.trim())}
          >
            {pending ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      <p className="muted">{description}</p>
      <Field label="Reason (recorded in the audit log)">
        {(id) => <textarea id={id} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />}
      </Field>
    </Dialog>
  );
}

function Actions({ order }: { order: OrderDetail }) {
  const { can } = useAuth();
  const toast = useToast();
  const [dialog, setDialog] = useState<'refund' | 'cancel' | null>(null);
  const advance = useAdvanceFulfillment(order.id);
  const refund = useRefundOrder(order.id);
  const cancel = useCancelOrder(order.id);
  const next = order.actions.nextFulfillment;
  const canCancel =
    order.actions.canCancel && can('orders:edit') && (!order.actions.cancelRequiresRefund || can('orders:refund'));
  const canRefund = order.actions.canRefund && can('orders:refund');
  const fail = (err: Error) => toast(err.message, 'error');

  return (
    <>
      {canRefund && (
        <button type="button" className="btn btn-secondary" onClick={() => setDialog('refund')}>
          <RotateCcw size={16} aria-hidden /> Refund
        </button>
      )}
      {canCancel && (
        <button type="button" className="btn btn-secondary btn-danger-text" onClick={() => setDialog('cancel')}>
          <Ban size={16} aria-hidden /> Cancel order
        </button>
      )}
      {next && next !== 'unfulfilled' && can('orders:edit') && (
        <button
          type="button"
          className="btn btn-primary"
          disabled={advance.isPending}
          onClick={() => advance.mutate(next, { onSuccess: () => toast(`Order #${order.number} is ${next}`), onError: fail })}
        >
          <Truck size={16} aria-hidden /> {NEXT_LABEL[next]}
        </button>
      )}

      {canRefund && (
        <ReasonDialog
          open={dialog === 'refund'}
          onClose={() => setDialog(null)}
          title={`Refund order #${order.number}?`}
          description={`${money(order.totalCents, order.currency)} will be returned to the customer's original payment method.${
            order.fulfillmentStatus === 'unfulfilled' || order.fulfillmentStatus === 'preparing'
              ? ' Items go back into stock.'
              : ''
          }`}
          confirmLabel="Refund in full"
          pending={refund.isPending}
          onConfirm={(reason) =>
            refund.mutate(reason, {
              onSuccess: () => {
                setDialog(null);
                toast(`Order #${order.number} refunded`);
              },
              onError: fail,
            })
          }
        />
      )}
      {canCancel && (
        <ReasonDialog
          open={dialog === 'cancel'}
          onClose={() => setDialog(null)}
          title={`Cancel order #${order.number}?`}
          description={
            order.actions.cancelRequiresRefund
              ? `The customer will be refunded ${money(order.totalCents, order.currency)} and items go back into stock.`
              : 'Reserved stock is released and the customer will not be charged.'
          }
          confirmLabel="Cancel order"
          danger
          pending={cancel.isPending}
          onConfirm={(reason) =>
            cancel.mutate(reason, {
              onSuccess: () => {
                setDialog(null);
                toast(`Order #${order.number} cancelled`);
              },
              onError: fail,
            })
          }
        />
      )}
    </>
  );
}

export function OrderDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const { data: order, error, isPending } = useOrder(id);

  if (isPending) return <Spinner />;
  if (error) return <ErrorState error={error} />;

  const a = order.shippingAddress;
  const p = order.payment;

  return (
    <>
      <PageHeader
        eyebrow={
          <Link to="/orders" className="back-link">
            <ArrowLeft size={16} aria-hidden /> Orders
          </Link>
        }
        title={
          <span className="title-with-badges">
            Order #{order.number}
            <PaymentBadge status={order.status} />
            <FulfillmentBadge status={order.fulfillmentStatus} />
          </span>
        }
        subtitle={`Placed ${formatDateTime(order.placedAt)}`}
        actions={<Actions order={order} />}
      />

      {order.status === 'cancelled' && (
        <div className="banner banner-danger" role="note">
          <Ban size={16} aria-hidden /> Cancelled{order.cancelledAt ? ` ${formatDateTime(order.cancelledAt)}` : ''}
          {order.cancelReason ? ` — ${order.cancelReason}` : ''}
        </div>
      )}
      {order.status === 'refunded' && (
        <div className="banner banner-neutral" role="note">
          <RotateCcw size={16} aria-hidden /> Refunded in full{order.refundedAt ? ` on ${formatDateTime(order.refundedAt)}` : ''}
        </div>
      )}

      <div className="detail-grid">
        <div className="detail-main">
          <section className="card" aria-labelledby="progress">
            <div className="card-header">
              <h2 id="progress">Progress</h2>
            </div>
            <div className="card-body">
              <Timeline steps={order.timeline} />
            </div>
          </section>

          <section className="card" aria-labelledby="items">
            <div className="card-header">
              <h2 id="items">Items</h2>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Product</th>
                    <th scope="col" className="num">
                      Qty
                    </th>
                    <th scope="col" className="num">
                      Price
                    </th>
                    <th scope="col" className="num">
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {order.items.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <div className="product-cell">
                          <Thumb url={i.imageUrl} alt={i.productName} />
                          <div className="cell-stack">
                            <span className="strong">{i.productName}</span>
                            <span className="muted small">
                              {i.variantLabel} · {i.sku}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td className="num">{i.qty}</td>
                      <td className="num">{money(i.unitPriceCents, order.currency)}</td>
                      <td className="num">{money(i.unitPriceCents * i.qty, order.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <dl className="totals">
              <div>
                <dt>Subtotal</dt>
                <dd>{money(order.subtotalCents, order.currency)}</dd>
              </div>
              {order.discountCents > 0 && (
                <div>
                  <dt>Discount{order.discountCode ? ` (${order.discountCode})` : ''}</dt>
                  <dd>−{money(order.discountCents, order.currency)}</dd>
                </div>
              )}
              <div>
                <dt>Shipping</dt>
                <dd>{order.shippingCents ? money(order.shippingCents, order.currency) : 'Free'}</dd>
              </div>
              <div>
                <dt>Tax</dt>
                <dd>{money(order.taxCents, order.currency)}</dd>
              </div>
              <div className="totals-grand">
                <dt>Total</dt>
                <dd>{money(order.totalCents, order.currency)}</dd>
              </div>
            </dl>
          </section>
        </div>

        <aside className="detail-side">
          <section className="card info-panel" aria-labelledby="customer">
            <h2 id="customer">
              <User size={16} aria-hidden /> Customer
            </h2>
            {order.customer ? (
              <>
                <p className="strong">
                  {can('customers:view') ? (
                    <Link to={`/customers/${order.customer.id}`} className="link">
                      {order.customer.name}
                    </Link>
                  ) : (
                    order.customer.name
                  )}
                </p>
                <p>
                  <a href={`mailto:${order.customer.email}`} className="link">
                    {order.customer.email}
                  </a>
                </p>
              </>
            ) : (
              <p className="muted">Customer record unavailable</p>
            )}
          </section>

          <section className="card info-panel" aria-labelledby="shipping">
            <h2 id="shipping">
              <MapPin size={16} aria-hidden /> Shipping address
            </h2>
            <address>
              {a.name}
              <br />
              {a.line1}
              {a.line2 && (
                <>
                  <br />
                  {a.line2}
                </>
              )}
              <br />
              {a.city}, {a.region} {a.postalCode}
              <br />
              {a.country}
            </address>
          </section>

          <section className="card info-panel" aria-labelledby="payment">
            <h2 id="payment">
              <CreditCard size={16} aria-hidden /> Payment
            </h2>
            {p ? (
              <dl className="kv">
                <div>
                  <dt>Status</dt>
                  <dd>{capitalize(p.status.replace('_', ' '))}</dd>
                </div>
                {p.cardLast4 && (
                  <div>
                    <dt>Card</dt>
                    <dd>
                      {capitalize(p.cardBrand ?? 'card')} •••• {p.cardLast4}
                    </dd>
                  </div>
                )}
                <div>
                  <dt>Amount</dt>
                  <dd>{money(p.amountCents, order.currency)}</dd>
                </div>
                {p.refundedCents > 0 && (
                  <div>
                    <dt>Refunded</dt>
                    <dd>{money(p.refundedCents, order.currency)}</dd>
                  </div>
                )}
                {p.failureReason && (
                  <div>
                    <dt>Failure</dt>
                    <dd>{p.failureReason.replaceAll('_', ' ')}</dd>
                  </div>
                )}
                {p.providerPaymentId && (
                  <div>
                    <dt>Reference</dt>
                    <dd className="mono small">{p.providerPaymentId}</dd>
                  </div>
                )}
              </dl>
            ) : (
              <p className="muted">No payment recorded</p>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}
