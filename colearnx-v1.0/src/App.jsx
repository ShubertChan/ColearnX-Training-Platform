import { Navigate, Route, Routes, Link, useLocation } from "react-router-dom";
import { ShieldCheck } from "lucide-react";
import Layout from "./components/Layout";
import PublicLayout from "./components/PublicLayout";
import { EmptyState } from "./components/ui";
import { usePlatform } from "./context/PlatformContext";
import { AuthPage, ForgotPasswordPage, ResetPasswordPage } from "./pages/AuthPages";
import { PrivacyPage, TermsPage } from "./pages/LegalPages";
import { VerifyEmailPage } from "./pages/VerifyEmailPage";
import { HomePage, ProfilePage, PublicProfilePage } from "./pages/AccountPlatformPages";
import {
  ContentDetailPage,
  ContentMarketplacePage,
  CourseDetailPage,
  CourseMarketplacePage,
} from "./pages/MarketplacePlatformPages";
import {
  CartPage,
  CheckoutSuccessPage,
  OrderHistoryPage,
  PurchasesPage,
  RefundPage,
} from "./pages/LearningPlatformPages";
import {
  ContentEditorPage,
  CourseEditorPage,
  PublishedPage,
  RoleApplicationPage,
} from "./pages/CreatorPlatformPages";
import { TransactionHistoryPage, WalletPage } from "./pages/WalletAdminPages";
import {
  AdminDashboardPage,
  AdminCatalogPage,
  AdminRefundPage,
  AdminRoleApplicationsPage,
} from "./pages/AdminPlatformPages";
import { AdminUserDetailPage, AdminUsersPage } from "./pages/AdminUserManagementPages";
import { intendedPath } from "./utils/frontendState";
import { PublishingToolsPage, AdminOperationsPage } from "./pages/WorkflowPages";

function PublishingAccess() {
  const { role } = usePlatform();
  return role === "Trainer" ? <TrainerOperational><PublishingToolsPage /></TrainerOperational> : <PublishingToolsPage />;
}

function Protected({ roles, children }) {
  const { role, approvedRoles } = usePlatform();
  const authorised =
    roles.includes(role) &&
    (role === "Admin" || role === "Member" || approvedRoles.includes(role));
  return authorised ? (
    children
  ) : (
    <Navigate to={role === "Admin" ? "/admin" : "/home"} replace />
  );
}

function Workspace({ children }) {
  const { authenticated, accountLoading, accountError, retrySession, dataStates, retryAccountData, orders, courseCatalogState, contentCatalogState } = usePlatform();
  const location = useLocation();
  if (accountLoading) return <div className="session-loading" role="status"><span className="session-spinner" /><b>Restoring your secure session…</b></div>;
  if (accountError) return <EmptyState title="Session temporarily unavailable" description={accountError} action={<button className="button primary" onClick={() => void retrySession()}>Retry session</button>} />;
  const required = location.pathname === "/home" ? ["wallet", "orders", "applications"]
    : ["/wallet", "/transactions"].includes(location.pathname) ? ["wallet"]
    : ["/orders", "/purchases"].includes(location.pathname) ? ["orders"]
    : location.pathname === "/cart" ? ["wallet", "catalog"]
    : location.pathname === "/role-application" ? ["applications", "certification"]
    : location.pathname.startsWith("/checkout-success") && !orders.length ? ["orders"] : [];
  const states = { ...dataStates, catalog: [courseCatalogState, contentCatalogState].some((state) => state.status === "error") ? "error" : [courseCatalogState, contentCatalogState].some((state) => state.status === "loading") ? "loading" : "ready" };
  const loading = required.some((name) => states[name] === "loading");
  const failed = required.some((name) => states[name] === "error");
  return authenticated ? (
    <Layout>{loading ? <p role="status">Loading account data…</p> : failed ? <EmptyState title="Account data unavailable" description="We could not load this section. Your session is still active." action={<button className="button primary" onClick={() => void retryAccountData()}>Retry account data</button>} /> : children}</Layout>
  ) : (
    <Navigate to="/login" replace state={{ from: location }} />
  );
}

function MarketplaceShell({ children }) {
  const { authenticated } = usePlatform();
  return authenticated ? <Layout>{children}</Layout> : <PublicLayout>{children}</PublicLayout>;
}

function AnonymousOnly({ children }) {
  const { authenticated, accountLoading, accountError, retrySession, role } = usePlatform();
  const location = useLocation();
  if (accountLoading) return <div className="session-loading" role="status"><span className="session-spinner" /><b>Checking your session…</b></div>;
  if (accountError) return <EmptyState title="Session temporarily unavailable" description={accountError} action={<button className="button primary" onClick={() => void retrySession()}>Retry session</button>} />;
  if (!authenticated) return children;
  return <Navigate to={intendedPath(location.state?.from, role === "Admin" ? "/admin" : "/home")} replace />;
}

function BuyerOnly({ children }) {
  const { canPurchase, role } = usePlatform();
  return canPurchase ? children : <Navigate to={role === "Admin" ? "/admin" : "/home"} replace />;
}

function TrainerOperational({ children }) {
  const { trainerOperational } = usePlatform();
  return trainerOperational ? children : <EmptyState icon={ShieldCheck} title="Trainer certification required" description="Your Trainer role is not operational until an administrator approves the certification prerequisite." action={<Link className="button primary" to="/role-application">View certification status</Link>} />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<AnonymousOnly><AuthPage /></AnonymousOnly>} />
      <Route path="/register" element={<AnonymousOnly><AuthPage mode="register" /></AnonymousOnly>} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/terms" element={<TermsPage />} />
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route
        path="/home"
        element={
          <Workspace>
            <HomePage />
          </Workspace>
        }
      />
      <Route
        path="/profile"
        element={
          <Workspace>
            <ProfilePage />
          </Workspace>
        }
      />
      <Route
        path="/public-profile/:id"
        element={
          <MarketplaceShell>
            <PublicProfilePage />
          </MarketplaceShell>
        }
      />
      <Route
        path="/courses"
        element={
          <MarketplaceShell>
            <CourseMarketplacePage />
          </MarketplaceShell>
        }
      />
      <Route
        path="/courses/:id"
        element={
          <MarketplaceShell>
            <CourseDetailPage />
          </MarketplaceShell>
        }
      />
      <Route
        path="/contents"
        element={
          <MarketplaceShell>
            <ContentMarketplacePage />
          </MarketplaceShell>
        }
      />
      <Route
        path="/contents/:id"
        element={
          <MarketplaceShell>
            <ContentDetailPage />
          </MarketplaceShell>
        }
      />
      <Route
        path="/cart"
        element={
          <Workspace>
            <BuyerOnly><CartPage /></BuyerOnly>
          </Workspace>
        }
      />
      <Route
        path="/checkout-success"
        element={
          <Workspace>
            <BuyerOnly><CheckoutSuccessPage /></BuyerOnly>
          </Workspace>
        }
      />
      <Route
        path="/checkout-success/:orderId"
        element={
          <Workspace>
            <BuyerOnly><CheckoutSuccessPage /></BuyerOnly>
          </Workspace>
        }
      />
      <Route
        path="/orders"
        element={
          <Workspace>
            <BuyerOnly><OrderHistoryPage /></BuyerOnly>
          </Workspace>
        }
      />
      <Route
        path="/purchases"
        element={
          <Workspace>
            <BuyerOnly><PurchasesPage /></BuyerOnly>
          </Workspace>
        }
      />
      <Route
        path="/refund/:id"
        element={
          <Workspace>
            <BuyerOnly><RefundPage /></BuyerOnly>
          </Workspace>
        }
      />
      <Route
        path="/role-application"
        element={
          <Workspace>
            <BuyerOnly><RoleApplicationPage /></BuyerOnly>
          </Workspace>
        }
      />
      <Route
        path="/trainer/course-editor"
        element={
          <Workspace>
            <Protected roles={["Trainer"]}>
              <TrainerOperational><CourseEditorPage /></TrainerOperational>
            </Protected>
          </Workspace>
        }
      />
      <Route
        path="/creator/content-editor"
        element={
          <Workspace>
            <Protected roles={["Creator"]}>
              <ContentEditorPage />
            </Protected>
          </Workspace>
        }
      />
      <Route
        path="/published"
        element={
          <Workspace>
            <Protected roles={["Trainer", "Creator"]}>
              <PublishedPage />
            </Protected>
          </Workspace>
        }
      />
      <Route
        path="/wallet"
        element={
          <Workspace>
            <BuyerOnly><WalletPage /></BuyerOnly>
          </Workspace>
        }
      />
      <Route
        path="/transactions"
        element={
          <Workspace>
            <BuyerOnly><TransactionHistoryPage /></BuyerOnly>
          </Workspace>
        }
      />
      <Route
        path="/admin"
        element={
          <Workspace>
            <Protected roles={["Admin"]}>
              <AdminDashboardPage />
            </Protected>
          </Workspace>
        }
      />
      <Route
        path="/admin/applications"
        element={
          <Workspace>
            <Protected roles={["Admin"]}>
              <AdminRoleApplicationsPage />
            </Protected>
          </Workspace>
        }
      />
      <Route
        path="/admin/refunds"
        element={
          <Workspace>
            <Protected roles={["Admin"]}>
              <AdminRefundPage />
            </Protected>
          </Workspace>
        }
      />
      <Route
        path="/admin/users"
        element={
          <Workspace>
            <Protected roles={["Admin"]}>
              <AdminUsersPage />
            </Protected>
          </Workspace>
        }
      />
      <Route
        path="/admin/users/:userId"
        element={
          <Workspace>
            <Protected roles={["Admin"]}>
              <AdminUserDetailPage />
            </Protected>
          </Workspace>
        }
      />
      <Route
        path="/admin/catalog"
        element={
          <Workspace>
            <Protected roles={["Admin"]}>
              <AdminCatalogPage />
            </Protected>
          </Workspace>
        }
      />
      <Route path="/publishing-tools" element={<Workspace><Protected roles={["Trainer", "Creator"]}><PublishingAccess /></Protected></Workspace>} />
      <Route path="/admin/operations" element={<Workspace><Protected roles={["Admin"]}><AdminOperationsPage /></Protected></Workspace>} />
      <Route path="/" element={<Navigate to="/courses" replace />} />
      <Route path="*" element={<Navigate to="/courses" replace />} />
    </Routes>
  );
}
