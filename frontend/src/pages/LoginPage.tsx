import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import logoImg from '../assets/logo-home.png';

export function LoginPage() {
  const { login } = useAuth();
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(userId.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-layout">
      <div className="login-layout__logo-zone" aria-hidden>
        <img src={logoImg} alt="" className="login-layout__logo-img" />
      </div>
      <div className="login-card">
        <div className="login-card__brand">
          <div className="login-card__brand-title">TRIDENT VIRTUAL AI</div>
          <div className="login-card__brand-sub">Intelligence Platform</div>
        </div>
        <form className="login-form" onSubmit={handleSubmit}>
          <div className="login-field">
            <label className="login-field__label" htmlFor="login-userId">
              User ID
            </label>
            <input
              id="login-userId"
              type="text"
              className="login-field__input"
              placeholder="User ID"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              autoComplete="username"
              required
              disabled={loading}
            />
          </div>
          <div className="login-field">
            <label className="login-field__label" htmlFor="login-password">
              Password
            </label>
            <input
              id="login-password"
              type="password"
              className="login-field__input"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              disabled={loading}
            />
          </div>
          {error && <p className="login-form__error" role="alert">{error}</p>}
          <button type="submit" className="login-form__submit" disabled={loading}>
            {loading ? '…' : 'Continue'}
          </button>
        </form>
      </div>
    </div>
  );
}
