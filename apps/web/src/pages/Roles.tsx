import { Copy, Lock, Plus, UserPlus, Users } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useInviteStaff, useRoles, useStaff } from '../api/hooks';
import { Avatar, Badge, Dialog, ErrorState, Field, PageHeader, Spinner } from '../components/ui';
import { useAuth } from '../lib/auth';
import { relativeTime } from '../lib/format';
import { useToast } from '../lib/toast';

function InviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const roles = useRoles();
  const { me } = useAuth();
  const invite = useInviteStaff();
  const toast = useToast();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  // Only Super Admins may hand out Super Admin; the server enforces this too.
  const assignable = (roles.data ?? []).filter((r) => !r.isSystem || me?.role?.isSystem);

  const close = () => {
    setName('');
    setEmail('');
    setRoleId('');
    setInviteUrl(null);
    invite.reset();
    onClose();
  };

  function submit(e: FormEvent) {
    e.preventDefault();
    invite.mutate(
      { name, email, roleId },
      {
        onSuccess: (r) => {
          toast(`Invitation sent to ${email}`);
          if (r.inviteUrl) setInviteUrl(r.inviteUrl);
          else close();
        },
      },
    );
  }

  return (
    <Dialog open={open} onClose={close} title={inviteUrl ? 'Invitation sent' : 'Invite a teammate'}>
      {inviteUrl ? (
        <>
          <p className="muted">
            {name} appears as <strong>Pending</strong> until they accept. In development the link is shown here instead of emailed:
          </p>
          <div className="copy-row">
            <input readOnly value={inviteUrl} aria-label="Invitation link" onFocus={(e) => e.currentTarget.select()} />
            <button type="button" className="btn btn-secondary" onClick={() => void navigator.clipboard.writeText(inviteUrl).then(() => toast('Link copied'))}>
              <Copy size={16} aria-hidden /> Copy
            </button>
          </div>
          <div className="dialog-footer">
            <button type="button" className="btn btn-primary" onClick={close}>
              Done
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={submit}>
          {invite.error && (
            <p className="form-error" role="alert">
              {invite.error.message}
            </p>
          )}
          <Field label="Full name">{(id) => <input id={id} value={name} onChange={(e) => setName(e.target.value)} required />}</Field>
          <Field label="Work email">{(id) => <input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />}</Field>
          <Field label="Role" hint="You can only assign roles whose permissions you hold yourself.">
            {(id) => (
              <select id={id} value={roleId} onChange={(e) => setRoleId(e.target.value)} required>
                <option value="" disabled>
                  Choose a role…
                </option>
                {assignable.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <div className="dialog-footer">
            <button type="button" className="btn btn-secondary" onClick={close}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={invite.isPending}>
              {invite.isPending ? 'Sending…' : 'Send invitation'}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

export function RolesPage() {
  const { can } = useAuth();
  const roles = useRoles();
  const staff = useStaff();
  const [inviting, setInviting] = useState(false);

  return (
    <>
      <PageHeader
        title="Roles & permissions"
        subtitle="Control what each teammate can see and change. Every change is recorded in the audit log."
        actions={
          can('settings:create') && (
            <Link to="/settings/roles/new" className="btn btn-secondary">
              <Plus size={16} aria-hidden /> New role
            </Link>
          )
        }
      />

      {roles.isPending ? (
        <Spinner />
      ) : roles.error ? (
        <ErrorState error={roles.error} />
      ) : (
        <ul className="role-grid" aria-label="Roles">
          {roles.data.map((r) => (
            <li key={r.id}>
              <Link to={`/settings/roles/${r.id}`} className="card role-card">
                <span className="role-card-title">
                  {r.name}
                  {r.isSystem && (
                    <span className="role-lock" title="Built-in role">
                      <Lock size={14} aria-hidden />
                      <span className="sr-only">(built-in, locked)</span>
                    </span>
                  )}
                </span>
                <span className="role-card-desc">{r.description || 'No description'}</span>
                <span className="role-card-meta">
                  <span>
                    <Users size={14} aria-hidden /> {r.memberCount} member{r.memberCount === 1 ? '' : 's'}
                  </span>
                  <span>
                    {r.permissionCount} permission{r.permissionCount === 1 ? '' : 's'}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <section className="card" aria-labelledby="team">
        <div className="card-header">
          <h2 id="team">Team</h2>
          {can('settings:create') && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setInviting(true)}>
              <UserPlus size={16} aria-hidden /> Invite teammate
            </button>
          )}
        </div>
        {staff.isPending ? (
          <Spinner />
        ) : staff.error ? (
          <ErrorState error={staff.error} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  <th scope="col">Status</th>
                  <th scope="col">Last active</th>
                </tr>
              </thead>
              <tbody>
                {staff.data.items.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <div className="person-cell">
                        <Avatar name={s.name} url={s.avatarUrl} />
                        <span className="strong">{s.name}</span>
                      </div>
                    </td>
                    <td className="muted">{s.email}</td>
                    <td>{s.role ? <Link to={`/settings/roles/${s.role.id}`} className="link">{s.role.name}</Link> : <span className="muted">No role</span>}</td>
                    <td>{s.status === 'active' ? <Badge tone="success">Active</Badge> : <Badge tone="warning">Pending</Badge>}</td>
                    <td className="muted">{s.status === 'invited' ? 'Invitation sent' : relativeTime(s.lastActiveAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <InviteDialog open={inviting} onClose={() => setInviting(false)} />
    </>
  );
}
