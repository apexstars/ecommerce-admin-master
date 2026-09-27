import { useState, type FormEvent } from 'react';
import { useAuth } from '../lib/auth';

export function LoginPage() {
  const { login, verifyTwoFactor } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (challenge) {
        await verifyTwoFactor(challenge, code.trim());
      } else {
        const res = await login(email, password);
        if (res.status === '2fa_required') setChallenge(res.challengeToken);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit} noValidate>
        <div className="brand brand-light">
          <span className="brand-mark" aria-hidden>
            M
          </span>
          <span className="brand-name">Meridian Admin</span>
        </div>
        <h1>{challenge ? 'Two-step verification' : 'Sign in'}</h1>
        <p className="muted">{challenge ? 'Enter the 6-digit code from your authenticator app.' : 'Staff access only.'}</p>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        {challenge ? (
          <div className="field">
            <label htmlFor="code">Verification code</label>
            <input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus
              required
            />
          </div>
        ) : (
          <>
            <div className="field">
              <label htmlFor="email">Work email</label>
              <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
          </>
        )}

        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Signing in…' : challenge ? 'Verify' : 'Sign in'}
        </button>
        {challenge && (
          <button type="button" className="btn btn-ghost btn-block" onClick={() => setChallenge(null)}>
            Use a different account
          </button>
        )}
      </form>
    </div>
  );
}
