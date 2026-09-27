import { LayoutDashboard, LogOut, Menu, Package, ShieldCheck, ShoppingBag, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import type { PermissionKey } from '../api/types';
import { useAuth } from '../lib/auth';
import { Avatar } from './ui';

const NAV: { to: string; label: string; icon: typeof Package; permission?: PermissionKey }[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/orders', label: 'Orders', icon: ShoppingBag, permission: 'orders:view' },
  { to: '/products', label: 'Products', icon: Package, permission: 'products:view' },
  { to: '/settings/roles', label: 'Roles & Permissions', icon: ShieldCheck, permission: 'settings:view' },
];

export function Layout() {
  const { me, can, logout } = useAuth();
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setNavOpen(false), [location.pathname]);

  return (
    <div className="shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      <header className="topbar">
        <button type="button" className="icon-btn icon-btn-dark" aria-label="Open navigation" aria-expanded={navOpen} onClick={() => setNavOpen(true)}>
          <Menu size={20} aria-hidden />
        </button>
        <span className="brand-name">Meridian</span>
      </header>

      <aside className={`sidebar${navOpen ? ' is-open' : ''}`} aria-label="Primary">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            M
          </span>
          <span className="brand-name">Meridian</span>
          <button type="button" className="icon-btn icon-btn-dark sidebar-close" aria-label="Close navigation" onClick={() => setNavOpen(false)}>
            <X size={18} aria-hidden />
          </button>
        </div>

        <nav className="nav">
          <ul>
            {NAV.filter((n) => !n.permission || can(n.permission)).map(({ to, label, icon: Icon }) => (
              <li key={to}>
                <NavLink to={to} end={to === '/'} className="nav-link">
                  <Icon size={18} aria-hidden />
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        {me && (
          <div className="sidebar-user">
            <Avatar name={me.name} size={34} />
            <div className="sidebar-user-text">
              <span className="sidebar-user-name">{me.name}</span>
              <span className="sidebar-user-role">{me.role?.name ?? 'No role'}</span>
            </div>
            <button type="button" className="icon-btn icon-btn-dark" aria-label="Sign out" title="Sign out" onClick={() => void logout()}>
              <LogOut size={18} aria-hidden />
            </button>
          </div>
        )}
      </aside>
      {navOpen && <button type="button" className="scrim" aria-label="Close navigation" onClick={() => setNavOpen(false)} />}

      <main id="main" className="content" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
