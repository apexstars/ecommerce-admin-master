// Public API of the identity module. Other modules import from here only.
export { adminOf, installAdminGuard } from './admin-guard.js';
export { optionalCustomer, requireCustomer, type CustomerPrincipal } from './customer-auth.service.js';
export { getAddress, getCustomerSummaries, searchCustomerIds, type CustomerSummary } from './customers.service.js';
export type { PermissionKey } from './permissions.js';
export { assertCan, can, type AdminPrincipal } from './rbac.js';
export { adminAuthRoutes, customerAuthRoutes, customersAdminRoutes, rolesAdminRoutes } from './routes.js';
