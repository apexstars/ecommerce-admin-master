import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/auth';

export function AcceptInvitePage() {
  const { acceptInvite } = useAuth();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError("Passwords don't match");
    if (password.length < 10) return setError('Use at least 10 characters');
    setBusy(true);
    setError(null);
    try {
      await acceptInvite(token, name, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not accept the invitation');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <h1>Join the team</h1>
        <p className="muted">Set up your account to accept the invitation.</p>
        {!token && (
          <p className="form-error" role="alert">
            This link is missing its invitation token.
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="field">
          <label htmlFor="name">Your name</label>
          <input id="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="new-password">Password</label>
          <input id="new-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} />
          <p className="field-hint">At least 10 characters.</p>
        </div>
        <div className="field">
          <label htmlFor="confirm-password">Confirm password</label>
          <input id="confirm-password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </div>
        <button type="submit" className="btn btn-primary btn-block" disabled={busy || !token}>
          {busy ? 'Setting up…' : 'Create account'}
        </button>
      </form>
    </div>
  );
}
