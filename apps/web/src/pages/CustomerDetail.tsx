import { ArrowLeft, Mail, MapPin, Pencil, Plus, ShieldOff, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useCustomer, useCustomerMutations, useCustomerStats, useOrders } from '../api/hooks';
import type { Address, AddressInput, CustomerDetail } from '../api/types';
import { AddressFields, cleanAddress, emptyAddress } from '../components/AddressFields';
import { Badge, Dialog, ErrorState, Field, FulfillmentBadge, PageHeader, Pagination, PaymentBadge, Spinner } from '../components/ui';
import { useAuth } from '../lib/auth';
import { formatDate, formatDateTime, money, relativeTime } from '../lib/format';
import { useToast } from '../lib/toast';

type Mutations = ReturnType<typeof useCustomerMutations>;

function EditDialog({ customer, open, onClose, m }: { customer: CustomerDetail; open: boolean; onClose: () => void; m: Mutations }) {
  const toast = useToast();
  const [name, setName] = useState(customer.name);
  const [email, setEmail] = useState(customer.email);
  useEffect(() => {
    if (!open) return;
    setName(customer.name);
    setEmail(customer.email);
    m.update.reset();
  }, [open, customer]);

  function submit(e: FormEvent) {
    e.preventDefault();
    m.update.mutate({ name, email }, { onSuccess: () => (toast('Customer updated'), onClose()) });
  }

  return (
    <Dialog open={open} onClose={onClose} title="Edit customer">
      <form onSubmit={submit}>
        {m.update.error && (
          <p className="form-error" role="alert">
            {m.update.error.message}
          </p>
        )}
        <Field label="Full name">{(id) => <input id={id} value={name} onChange={(e) => setName(e.target.value)} required />}</Field>
        <Field label="Email">{(id) => <input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />}</Field>
        <div className="dialog-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={m.update.isPending}>
            {m.update.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** `editing` is an existing address, `'new'` for a new one, or null when closed. */
function AddressDialog({ editing, customer, onClose, m }: { editing: Address | 'new' | null; customer: CustomerDetail; onClose: () => void; m: Mutations }) {
  const toast = useToast();
  const [value, setValue] = useState<AddressInput>(emptyAddress());
  const [makeDefault, setMakeDefault] = useState(false);
  const isNew = editing === 'new';
  const mutation = isNew ? m.addAddress : m.updateAddress;

  useEffect(() => {
    if (!editing) return;
    m.addAddress.reset();
    m.updateAddress.reset();
    if (editing === 'new') {
      setValue(emptyAddress(customer.name));
      setMakeDefault(customer.addresses.length === 0);
    } else {
      const { id: _id, isDefault, ...rest } = editing;
      setValue(rest);
      setMakeDefault(isDefault);
    }
  }, [editing]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const body = { ...cleanAddress(value), isDefault: makeDefault || undefined };
    const done = { onSuccess: () => (toast(isNew ? 'Address added' : 'Address updated'), onClose()) };
    if (editing === 'new') m.addAddress.mutate(body, done);
    else if (editing) m.updateAddress.mutate({ ...body, addressId: editing.id }, done);
  }

  const alreadyDefault = editing !== 'new' && editing?.isDefault;
  return (
    <Dialog open={editing !== null} onClose={onClose} title={isNew ? 'Add address' : 'Edit address'} wide>
      <form onSubmit={submit}>
        {mutation.error && (
          <p className="form-error" role="alert">
            {mutation.error.message}
          </p>
        )}
        <AddressFields value={value} onChange={setValue} />
        {!alreadyDefault && (
          <label className="checkbox-row">
            <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />
            Use as default shipping address
          </label>
        )}
        <div className="dialog-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : isNew ? 'Add address' : 'Save address'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function EraseDialog({ customer, open, onClose, m }: { customer: CustomerDetail; open: boolean; onClose: () => void; m: Mutations }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState('');
  useEffect(() => {
    if (open) setConfirm('');
  }, [open]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Erase ${customer.name}?`}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={confirm !== 'ERASE' || m.erase.isPending}
            onClick={() =>
              m.erase.mutate(undefined, {
                onSuccess: () => (toast('Customer data erased'), onClose()),
                onError: (e) => toast(e.message, 'error'),
              })
            }
          >
            {m.erase.isPending ? 'Erasing…' : 'Erase personal data'}
          </button>
        </>
      }
    >
      <p className="muted">
        This permanently removes their name, email, storefront login and saved addresses, and signs them out. Their orders stay in
        place for accounting, attached to an anonymous record. <strong>This can't be undone.</strong>
      </p>
      <Field label="Type ERASE to confirm">
        {(id) => <input id={id} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />}
      </Field>
    </Dialog>
  );
}

function CustomerOrders({ customerId }: { customerId: string }) {
  const [page, setPage] = useState(1);
  const { data, error, isPending } = useOrders({ filter: 'all', search: '', page, customerId });
  return (
    <section className="card" aria-labelledby="orders-heading">
      <div className="card-header">
        <h2 id="orders-heading">Order history</h2>
      </div>
      {isPending ? (
        <Spinner />
      ) : error ? (
        <ErrorState error={error} />
      ) : data.total === 0 ? (
        <p className="card-body muted">No orders yet.</p>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Order</th>
                  <th scope="col">Placed</th>
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
                {data.items.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link to={`/orders/${o.id}`} className="link-strong">
                        #{o.number}
                      </Link>
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
          {data.total > data.pageSize && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
        </>
      )}
    </section>
  );
}

export function CustomerDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const { data: customer, error, isPending } = useCustomer(id);
  const m = useCustomerMutations(id);
  const showOrders = can('orders:view');
  const stats = useCustomerStats([id], showOrders);
  const [dialog, setDialog] = useState<'edit' | 'erase' | null>(null);
  const [addressDialog, setAddressDialog] = useState<Address | 'new' | null>(null);

  if (isPending) return <Spinner />;
  if (error) return <ErrorState error={error} />;

  const erased = Boolean(customer.erasedAt);
  const canEdit = can('customers:edit') && !erased;
  const s = stats.data?.[id];

  return (
    <>
      <PageHeader
        eyebrow={
          <Link to="/customers" className="back-link">
            <ArrowLeft size={16} aria-hidden /> Customers
          </Link>
        }
        title={
          <span className="title-with-badges">
            {customer.name}
            {erased ? (
              <Badge tone="neutral">Erased</Badge>
            ) : customer.hasAccount ? (
              <Badge tone="info">Registered</Badge>
            ) : (
              <Badge tone="neutral">Guest</Badge>
            )}
          </span>
        }
        subtitle={erased ? 'Personal data removed' : `${customer.email} · Customer since ${formatDate(customer.createdAt)}`}
        actions={
          !erased && (
            <>
              {can('customers:delete') && (
                <button type="button" className="btn btn-secondary btn-danger-text" onClick={() => setDialog('erase')}>
                  <Trash2 size={16} aria-hidden /> Erase customer
                </button>
              )}
              {canEdit && (
                <button type="button" className="btn btn-secondary" onClick={() => setDialog('edit')}>
                  <Pencil size={16} aria-hidden /> Edit details
                </button>
              )}
            </>
          )
        }
      />

      {erased && (
        <div className="banner banner-neutral" role="note">
          <ShieldOff size={16} aria-hidden /> Personal data was erased {formatDateTime(customer.erasedAt!)}. Their orders are kept for
          accounting.
        </div>
      )}

      {showOrders && (
        <div className="stat-grid stat-grid-4">
          <section className="card stat-card stat-card-sm" aria-label="Orders">
            <h2 className="stat-label">Orders</h2>
            <p className="stat-value">{s ? s.orderCount : '…'}</p>
          </section>
          <section className="card stat-card stat-card-sm" aria-label="Lifetime spend">
            <h2 className="stat-label">Lifetime spend</h2>
            <p className="stat-value">{s ? money(s.totalSpentCents) : '…'}</p>
            <p className="stat-foot muted">Paid orders only</p>
          </section>
          <section className="card stat-card stat-card-sm" aria-label="Average order">
            <h2 className="stat-label">Average order</h2>
            <p className="stat-value">{s ? (s.paidOrderCount ? money(Math.round(s.totalSpentCents / s.paidOrderCount)) : '—') : '…'}</p>
          </section>
          <section className="card stat-card stat-card-sm" aria-label="Last order">
            <h2 className="stat-label">Last order</h2>
            <p className="stat-value stat-value-text">{s ? (s.lastOrderAt ? relativeTime(s.lastOrderAt) : 'Never') : '…'}</p>
          </section>
        </div>
      )}

      <div className="detail-grid">
        <div className="detail-main">
          {showOrders ? (
            <CustomerOrders customerId={id} />
          ) : (
            <section className="card card-body muted">Order history needs orders access.</section>
          )}
        </div>

        <aside className="detail-side">
          {!erased && (
            <section className="card info-panel" aria-labelledby="contact">
              <h2 id="contact">
                <Mail size={16} aria-hidden /> Contact
              </h2>
              <p>
                <a href={`mailto:${customer.email}`} className="link">
                  {customer.email}
                </a>
              </p>
              <p className="muted small">
                {customer.hasAccount ? 'Has a storefront login' : 'No storefront login yet (guest or added by staff)'}
              </p>
            </section>
          )}

          <section className="card" aria-labelledby="addresses">
            <div className="card-header">
              <h2 id="addresses" className="icon-heading">
                <MapPin size={16} aria-hidden /> Addresses
              </h2>
              {canEdit && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAddressDialog('new')}>
                  <Plus size={14} aria-hidden /> Add
                </button>
              )}
            </div>
            {customer.addresses.length === 0 ? (
              <p className="card-body muted">{erased ? 'Erased.' : 'No saved addresses.'}</p>
            ) : (
              <ul className="address-list">
                {customer.addresses.map((a) => (
                  <li key={a.id}>
                    <address>
                      {a.isDefault && (
                        <span className="address-default">
                          <Badge tone="info">Default</Badge>
                        </span>
                      )}
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
                    {canEdit && (
                      <div className="address-actions">
                        {!a.isDefault && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={m.updateAddress.isPending}
                            onClick={() =>
                              m.updateAddress.mutate(
                                { addressId: a.id, isDefault: true },
                                { onSuccess: () => toast('Default address updated'), onError: (e) => toast(e.message, 'error') },
                              )
                            }
                          >
                            Make default
                          </button>
                        )}
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAddressDialog(a)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm btn-danger-text"
                          disabled={m.removeAddress.isPending}
                          aria-label={`Remove address ${a.line1}`}
                          onClick={() =>
                            m.removeAddress.mutate(a.id, {
                              onSuccess: () => toast('Address removed'),
                              onError: (e) => toast(e.message, 'error'),
                            })
                          }
                        >
                          Remove
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>

      <EditDialog customer={customer} open={dialog === 'edit'} onClose={() => setDialog(null)} m={m} />
      <EraseDialog customer={customer} open={dialog === 'erase'} onClose={() => setDialog(null)} m={m} />
      <AddressDialog editing={addressDialog} customer={customer} onClose={() => setAddressDialog(null)} m={m} />
    </>
  );
}
