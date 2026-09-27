import type { ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { PermissionKey } from './api/types';
import { Layout } from './components/Layout';
import { NoAccess, Spinner } from './components/ui';
import { useAuth } from './lib/auth';
import { AcceptInvitePage } from './pages/AcceptInvite';
import { CustomerDetailPage } from './pages/CustomerDetail';
import { CustomersPage } from './pages/Customers';
import { DashboardPage } from './pages/Dashboard';
import { LoginPage } from './pages/Login';
import { OrderDetailPage } from './pages/OrderDetail';
import { OrdersPage } from './pages/Orders';
import { ProductsPage } from './pages/Products';
import { RoleEditorPage } from './pages/RoleEditor';
import { RolesPage } from './pages/Roles';

/** UI gating mirrors the server's checks for a better experience; the server remains the authority. */
function Guard({ permission, what, children }: { permission: PermissionKey; what: string; children: ReactNode }) {
  const { can } = useAuth();
  return can(permission) ? <>{children}</> : <NoAccess what={what} />;
}

export function App() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <Spinner label="Loading your session" />;

  if (status === 'signed-out') {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/accept-invite" element={<AcceptInvitePage />} />
        <Route path="*" element={<Navigate to="/login" replace state={{ from: location.pathname }} />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to={(location.state as { from?: string } | null)?.from ?? '/'} replace />} />
      <Route path="/accept-invite" element={<Navigate to="/" replace />} />
      <Route element={<Layout />}>
        <Route index element={<DashboardPage />} />
        <Route path="orders" element={<Guard permission="orders:view" what="orders"><OrdersPage /></Guard>} />
        <Route path="orders/:id" element={<Guard permission="orders:view" what="orders"><OrderDetailPage /></Guard>} />
        <Route path="products" element={<Guard permission="products:view" what="products"><ProductsPage /></Guard>} />
        <Route path="customers" element={<Guard permission="customers:view" what="customers"><CustomersPage /></Guard>} />
        <Route path="customers/:id" element={<Guard permission="customers:view" what="customers"><CustomerDetailPage /></Guard>} />
        <Route path="settings/roles" element={<Guard permission="settings:view" what="roles and permissions"><RolesPage /></Guard>} />
        <Route path="settings/roles/:id" element={<Guard permission="settings:view" what="roles and permissions"><RoleEditorPage /></Guard>} />
        <Route
          path="*"
          element={
            <div className="card empty-state">
              <p>That page doesn't exist.</p>
              <Link to="/">Back to dashboard</Link>
            </div>
          }
        />
      </Route>
    </Routes>
  );
}
