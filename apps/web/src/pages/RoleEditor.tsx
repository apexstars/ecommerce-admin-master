import { ArrowLeft, Lock, Trash2, UserMinus } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAudit, usePermissionCatalog, useRole, useRoleMutations, useStaff } from '../api/hooks';
import type { Action, AuditEntry, PermissionKey, Resource } from '../api/types';
import { Avatar, Badge, Dialog, ErrorState, PageHeader, Spinner } from '../components/ui';
import { useAuth } from '../lib/auth';
import { capitalize, relativeTime } from '../lib/format';
import { useToast } from '../lib/toast';

const RESOURCE_HINT: Record<Resource, string> = {
  products: 'Catalog, variants, categories',
  inventory: 'Stock levels and adjustments',
  orders: 'Order lifecycle and fulfillment',
  discounts: 'Coupons and campaigns',
  customers: 'Customer records',
  reports: 'Dashboard and reports',
  settings: 'Staff, roles and permissions',
};

function describeAudit(e: AuditEntry) {
  const who = e.actor?.name ?? 'System';
  const m = e.metadata ?? {};
  switch (e.action) {
    case 'role.permissions_changed': {
      const added = (m.added as string[]) ?? [];
      const removed = (m.removed as string[]) ?? [];
      return `${who} ${[added.length && `granted ${added.join(', ')}`, removed.length && `revoked ${removed.join(', ')}`].filter(Boolean).join('; ')}`;
    }
    case 'role.updated':
      return `${who} renamed or re-described the role`;
    case 'role.created':
      return `${who} created the role`;
    default:
      return `${who}: ${e.action}`;
  }
}

export function RoleEditorPage() {
  const { id: routeId = '' } = useParams();
  const isNew = routeId === 'new';
  const id = isNew ? undefined : routeId;
  const navigate = useNavigate();
  const toast = useToast();
  const { me, can } = useAuth();

  const role = useRole(id);
  const catalog = usePermissionCatalog();
  const staff = useStaff();
  const audit = useAudit('role', id);
  const m = useRoleMutations(id);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [perms, setPerms] = useState<Set<PermissionKey>>(new Set());
  const [memberToAdd, setMemberToAdd] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // (Re)load form state whenever the server copy changes.
  useEffect(() => {
    if (!role.data) return;
    setName(role.data.name);
    setDescription(role.data.description);
    setPerms(new Set(role.data.permissions));
  }, [role.data]);

  const isSystem = role.data?.isSystem ?? false;
  const amSuperAdmin = Boolean(me?.role?.isSystem);
  const canWrite = isNew ? can('settings:create') : can('settings:edit') && !isSystem;
  const canManageMembers = can('settings:edit') && (!isSystem || amSuperAdmin);

  const dirty = useMemo(() => {
    if (isNew) return name.trim().length > 0;
    if (!role.data) return false;
    const orig = new Set(role.data.permissions);
    return (
      name !== role.data.name ||
      description !== role.data.description ||
      perms.size !== orig.size ||
      [...perms].some((p) => !orig.has(p))
    );
  }, [isNew, role.data, name, description, perms]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if ((!isNew && role.isPending) || catalog.isPending) return <Spinner />;
  if (role.error) return <ErrorState error={role.error} />;
  if (catalog.error) return <ErrorState error={catalog.error} />;

  const valid = new Set(catalog.data.permissions.map((p) => p.key));
  const key = (r: Resource, a: Action) => `${r}:${a}` as PermissionKey;
  // Mirrors the server's anti-escalation rule: you can only toggle what you hold.
  const editable = (k: PermissionKey) => canWrite && (amSuperAdmin || can(k));

  const toggle = (k: PermissionKey) =>
    setPerms((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const toggleRow = (r: Resource) => {
    const keys = catalog.data.actions.map((a) => key(r, a)).filter((k) => valid.has(k) && editable(k));
    const allOn = keys.every((k) => perms.has(k));
    setPerms((s) => {
      const n = new Set(s);
      for (const k of keys) {
        if (allOn) n.delete(k);
        else n.add(k);
      }
      return n;
    });
  };

  function save(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const body = { name: name.trim(), description: description.trim(), permissions: [...perms] };
    if (isNew) {
      m.create.mutate(body, {
        onSuccess: (created) => {
          toast(`Role “${created.name}” created`);
          navigate(`/settings/roles/${created.id}`, { replace: true });
        },
        onError: (err) => setFormError(err.message),
      });
    } else {
      m.update.mutate(body, {
        onSuccess: () => toast('Role saved'),
        onError: (err) => setFormError(err.message),
      });
    }
  }

  const members = role.data?.members ?? [];
  const memberIds = new Set(members.map((x) => x.id));
  const candidates = (staff.data?.items ?? []).filter((s) => !memberIds.has(s.id) && s.id !== me?.id);
  const saving = m.create.isPending || m.update.isPending;

  return (
    <form onSubmit={save} className="role-editor">
      <PageHeader
        eyebrow={
          <Link to="/settings/roles" className="back-link">
            <ArrowLeft size={16} aria-hidden /> Roles & permissions
          </Link>
        }
        title={
          <span className="title-with-badges">
            {isNew ? 'New role' : role.data?.name}
            {isSystem && (
              <Badge tone="neutral">
                <Lock size={12} aria-hidden /> Built-in
              </Badge>
            )}
          </span>
        }
        subtitle={
          isSystem
            ? 'Super Admin always has every permission. It cannot be edited or deleted.'
            : 'Choose exactly what people with this role can do.'
        }
        actions={
          <>
            {!isNew && can('settings:delete') && (
              <button
                type="button"
                className="btn btn-secondary btn-danger-text"
                disabled={isSystem || members.length > 0}
                title={isSystem ? 'Built-in roles cannot be deleted' : members.length ? 'Reassign members before deleting' : undefined}
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 size={16} aria-hidden /> Delete role
              </button>
            )}
            <button type="submit" className="btn btn-primary" disabled={!canWrite || !dirty || saving}>
              {saving ? 'Saving…' : isNew ? 'Create role' : 'Save changes'}
            </button>
          </>
        }
      />

      {formError && (
        <p className="banner banner-danger" role="alert">
          {formError}
        </p>
      )}

      <div className="detail-grid">
        <div className="detail-main">
          <section className="card card-body" aria-labelledby="details">
            <h2 id="details" className="section-title">
              Details
            </h2>
            <div className="field">
              <label htmlFor="role-name">Name</label>
              <input id="role-name" value={name} onChange={(e) => setName(e.target.value)} disabled={!canWrite} required maxLength={60} />
            </div>
            <div className="field">
              <label htmlFor="role-description">Description</label>
              <textarea
                id="role-description"
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={!canWrite}
                maxLength={300}
              />
            </div>
          </section>

          <section className="card" aria-labelledby="perm-heading">
            <div className="card-header">
              <h2 id="perm-heading">Permissions</h2>
              <span className="muted small">{perms.size} selected</span>
            </div>
            <div className="table-wrap">
              <table className="table matrix">
                <caption className="sr-only">Permission matrix: resources by actions</caption>
                <thead>
                  <tr>
                    <th scope="col">Resource</th>
                    {catalog.data.actions.map((a) => (
                      <th key={a} scope="col" className="center">
                        {capitalize(a)}
                      </th>
                    ))}
                    <th scope="col" className="center">
                      All
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {catalog.data.resources.map((r) => {
                    const rowKeys = catalog.data.actions.map((a) => key(r, a)).filter((k) => valid.has(k));
                    const rowOn = rowKeys.every((k) => perms.has(k));
                    return (
                      <tr key={r}>
                        <th scope="row">
                          <div className="cell-stack">
                            <span className="strong">{capitalize(r)}</span>
                            <span className="muted small">{RESOURCE_HINT[r]}</span>
                          </div>
                        </th>
                        {catalog.data.actions.map((a) => {
                          const k = key(r, a);
                          if (!valid.has(k)) {
                            return (
                              <td key={a} className="center muted">
                                <span aria-hidden>—</span>
                                <span className="sr-only">Not applicable</span>
                              </td>
                            );
                          }
                          const locked = !editable(k);
                          return (
                            <td key={a} className="center">
                              <input
                                type="checkbox"
                                className="matrix-check"
                                aria-label={`${capitalize(r)}: ${a}`}
                                checked={perms.has(k)}
                                disabled={locked}
                                title={canWrite && locked ? "You can't grant a permission you don't have" : undefined}
                                onChange={() => toggle(k)}
                              />
                            </td>
                          );
                        })}
                        <td className="center">
                          <input
                            type="checkbox"
                            className="matrix-check"
                            aria-label={`All ${r} permissions`}
                            checked={rowOn}
                            disabled={!canWrite}
                            onChange={() => toggleRow(r)}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <aside className="detail-side">
          <section className="card" aria-labelledby="members-heading">
            <div className="card-header">
              <h2 id="members-heading">Members</h2>
              <span className="muted small">{members.length}</span>
            </div>
            {isNew ? (
              <p className="card-body muted">Create the role first, then add people to it.</p>
            ) : (
              <>
                {members.length === 0 ? (
                  <p className="card-body muted">No one has this role yet.</p>
                ) : (
                  <ul className="member-list">
                    {members.map((u) => (
                      <li key={u.id}>
                        <Avatar name={u.name} url={u.avatarUrl} />
                        <div className="cell-stack">
                          <span className="strong">
                            {u.name} {u.status === 'invited' && <Badge tone="warning">Pending</Badge>}
                          </span>
                          <span className="muted small">{u.email}</span>
                        </div>
                        {canManageMembers && u.id !== me?.id && (
                          <button
                            type="button"
                            className="icon-btn"
                            aria-label={`Remove ${u.name} from this role`}
                            title="Remove from role"
                            disabled={m.removeMember.isPending}
                            onClick={() =>
                              m.removeMember.mutate(u.id, {
                                onSuccess: () => toast(`${u.name} removed from ${role.data?.name}`),
                                onError: (err) => toast(err.message, 'error'),
                              })
                            }
                          >
                            <UserMinus size={16} aria-hidden />
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {canManageMembers && (
                  <div className="add-member">
                    <label htmlFor="add-member" className="sr-only">
                      Add a teammate to this role
                    </label>
                    <select id="add-member" value={memberToAdd} onChange={(e) => setMemberToAdd(e.target.value)}>
                      <option value="">Add a teammate…</option>
                      {candidates.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} {s.role ? `(currently ${s.role.name})` : '(no role)'}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={!memberToAdd || m.addMember.isPending}
                      onClick={() =>
                        m.addMember.mutate(memberToAdd, {
                          onSuccess: () => {
                            setMemberToAdd('');
                            toast('Member added');
                          },
                          onError: (err) => toast(err.message, 'error'),
                        })
                      }
                    >
                      Add
                    </button>
                  </div>
                )}
                {!isSystem && <p className="card-foot muted small">Moving someone here removes them from their current role.</p>}
              </>
            )}
          </section>

          {!isNew && (
            <section className="card" aria-labelledby="history-heading">
              <div className="card-header">
                <h2 id="history-heading">Recent changes</h2>
              </div>
              {audit.data?.items.length ? (
                <ol className="audit-list">
                  {audit.data.items.map((e) => (
                    <li key={e.id}>
                      <span>{describeAudit(e)}</span>
                      <time className="muted small" dateTime={e.timestamp}>
                        {relativeTime(e.timestamp)}
                      </time>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="card-body muted">{audit.isPending ? 'Loading…' : 'No changes recorded yet.'}</p>
              )}
            </section>
          )}
        </aside>
      </div>

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete “${role.data?.name}”?`}
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={m.remove.isPending}
              onClick={() =>
                m.remove.mutate(undefined, {
                  onSuccess: () => {
                    toast('Role deleted');
                    navigate('/settings/roles');
                  },
                  onError: (err) => {
                    setConfirmDelete(false);
                    toast(err.message, 'error');
                  },
                })
              }
            >
              Delete role
            </button>
          </>
        }
      >
        <p className="muted">This can't be undone. The deletion is recorded in the audit log.</p>
      </Dialog>
    </form>
  );
}
