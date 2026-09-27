import { UserPlus } from 'lucide-react';
import { useCallback, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useCreateCustomer, useCustomers, useCustomerStats, type CustomersParams } from '../api/hooks';
import type { AddressInput } from '../api/types';
import { AddressFields, cleanAddress, emptyAddress } from '../components/AddressFields';
import { Avatar, Dialog, ErrorState, Field, PageHeader, Pagination, SearchInput, Spinner } from '../components/ui';
import { useAuth } from '../lib/auth';
import { formatDate, money, relativeTime } from '../lib/format';
import { useToast } from '../lib/toast';

function AddCustomerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateCustomer();
  const toast = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [withAddress, setWithAddress] = useState(false);
  const [address, setAddress] = useState<AddressInput>(emptyAddress());

  const close = () => {
    setName('');
    setEmail('');
    setWithAddress(false);
    setAddress(emptyAddress());
    create.reset();
    onClose();
  };

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate(
      { name, email, ...(withAddress && { address: cleanAddress({ ...address, name: address.name || name }) }) },
      {
        onSuccess: (c) => {
          toast(`${c.name} added`);
          close();
          navigate(`/customers/${c.id}`);
        },
      },
    );
  }

  return (
    <Dialog open={open} onClose={close} title="Add a customer" wide>
      <form onSubmit={submit}>
        {create.error && (
          <p className="form-error" role="alert">
            {create.error.message}
          </p>
        )}
        <Field label="Full name">{(id) => <input id={id} value={name} onChange={(e) => setName(e.target.value)} required autoFocus />}</Field>
        <Field label="Email" hint="They can claim this record later by signing up on the storefront with the same email.">
          {(id) => <input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />}
        </Field>
        <label className="checkbox-row">
          <input type="checkbox" checked={withAddress} onChange={(e) => setWithAddress(e.target.checked)} />
          Add a shipping address now
        </label>
        {withAddress && (
          <fieldset className="fieldset">
            <legend>Shipping address</legend>
            <AddressFields value={{ ...address, name: address.name || name }} onChange={setAddress} />
          </fieldset>
        )}
        <div className="dialog-footer">
          <button type="button" className="btn btn-secondary" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={create.isPending}>
            {create.isPending ? 'Adding…' : 'Add customer'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function CustomersPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const search = params.get('q') ?? '';
  const sort = (params.get('sort') as CustomersParams['sort'] | null) ?? 'newest';
  const page = Number(params.get('page') ?? 1);
  const [adding, setAdding] = useState(false);

  const update = useCallback(
    (next: Record<string, string | number | undefined>) =>
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(next)) {
            if (v === undefined || v === '' || (k === 'page' && v === 1) || (k === 'sort' && v === 'newest')) p.delete(k);
            else p.set(k, String(v));
          }
          return p;
        },
        { replace: true },
      ),
    [setParams],
  );
  const onSearch = useCallback((q: string) => update({ q, page: 1 }), [update]);

  const { data, error, isPending, isFetching } = useCustomers({ search, sort, page });
  // Purchase columns only appear for roles that can see orders.
  const showOrders = can('orders:view');
  const stats = useCustomerStats(data?.items.map((c) => c.id) ?? [], showOrders);
  const colSpan = showOrders ? 6 : 3;

  return (
    <>
      <PageHeader
        title="Customers"
        subtitle="Everyone who has shopped with you or been added by the team."
        actions={
          can('customers:create') && (
            <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
              <UserPlus size={16} aria-hidden /> Add customer
            </button>
          )
        }
      />
      <section className="card">
        <div className="toolbar">
          <SearchInput label="Search customers" placeholder="Name or email" value={search} onChange={onSearch} />
          <div className="select-wrap">
            <label htmlFor="customer-sort" className="sr-only">
              Sort customers
            </label>
            <select id="customer-sort" value={sort} onChange={(e) => update({ sort: e.target.value, page: 1 })}>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="name">Name A–Z</option>
            </select>
          </div>
        </div>

        {isPending ? (
          <Spinner />
        ) : error ? (
          <ErrorState error={error} />
        ) : (
          <>
            <div className="table-wrap table-wrap-tall" aria-busy={isFetching}>
              <table className="table">
                <caption className="sr-only">Customers</caption>
                <thead>
                  <tr>
                    <th scope="col">Customer</th>
                    <th scope="col">Location</th>
                    {showOrders && (
                      <>
                        <th scope="col" className="num">
                          Orders
                        </th>
                        <th scope="col" className="num">
                          Lifetime spend
                        </th>
                        <th scope="col">Last order</th>
                      </>
                    )}
                    <th scope="col">Customer since</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.length === 0 && (
                    <tr>
                      <td colSpan={colSpan} className="empty-cell">
                        {search ? `No customers match “${search}”.` : 'No customers yet.'}
                      </td>
                    </tr>
                  )}
                  {data.items.map((c) => {
                    const s = stats.data?.[c.id];
                    return (
                      <tr key={c.id}>
                        <td>
                          <div className="person-cell">
                            <Avatar name={c.name} />
                            <div className="cell-stack">
                              <Link to={`/customers/${c.id}`} className="link-strong">
                                {c.name}
                              </Link>
                              <span className="muted small">{c.email}</span>
                            </div>
                          </div>
                        </td>
                        <td className="muted">{c.location ? `${c.location.city}, ${c.location.region}` : '—'}</td>
                        {showOrders && (
                          <>
                            <td className="num">{s ? s.orderCount : '…'}</td>
                            <td className="num strong">{s ? money(s.totalSpentCents) : '…'}</td>
                            <td className="muted">{s ? (s.lastOrderAt ? relativeTime(s.lastOrderAt) : 'No orders yet') : '…'}</td>
                          </>
                        )}
                        <td className="muted nowrap">{formatDate(c.createdAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => update({ page: p })} />
          </>
        )}
      </section>
      <AddCustomerDialog open={adding} onClose={() => setAdding(false)} />
    </>
  );
}
