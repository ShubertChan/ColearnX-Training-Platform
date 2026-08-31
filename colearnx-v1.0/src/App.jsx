import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import { usePlatform } from "./context/PlatformContext";
import { AuthPage, ForgotPasswordPage } from "./pages/AuthPages";
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
  const { authenticated } = usePlatform();
  return authenticated ? (
    <Layout>{children}</Layout>
  ) : (
    <Navigate to="/login" replace />
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<AuthPage />} />
      <Route path="/register" element={<AuthPage mode="register" />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
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
          <Workspace>
            <PublicProfilePage />
          </Workspace>
        }
      />
      <Route
        path="/courses"
        element={
          <Workspace>
            <CourseMarketplacePage />
          </Workspace>
        }
      />
      <Route
        path="/courses/:id"
        element={
          <Workspace>
            <CourseDetailPage />
          </Workspace>
        }
      />
      <Route
        path="/contents"
        element={
          <Workspace>
            <ContentMarketplacePage />
          </Workspace>
        }
      />
      <Route
        path="/contents/:id"
        element={
          <Workspace>
            <ContentDetailPage />
          </Workspace>
        }
      />
      <Route
        path="/cart"
        element={
          <Workspace>
            <CartPage />
          </Workspace>
        }
      />
      <Route
        path="/checkout-success"
        element={
          <Workspace>
            <CheckoutSuccessPage />
          </Workspace>
        }
      />
      <Route
        path="/checkout-success/:orderId"
        element={
          <Workspace>
            <CheckoutSuccessPage />
          </Workspace>
        }
      />
      <Route
        path="/orders"
        element={
          <Workspace>
            <OrderHistoryPage />
          </Workspace>
        }
      />
      <Route
        path="/purchases"
        element={
          <Workspace>
            <PurchasesPage />
          </Workspace>
        }
      />
      <Route
        path="/refund/:id"
        element={
          <Workspace>
            <RefundPage />
          </Workspace>
        }
      />
      <Route
        path="/role-application"
        element={
          <Workspace>
            <RoleApplicationPage />
          </Workspace>
        }
      />
      <Route
        path="/trainer/course-editor"
        element={
          <Workspace>
            <Protected roles={["Trainer"]}>
              <CourseEditorPage />
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
            <WalletPage />
          </Workspace>
        }
      />
      <Route
        path="/transactions"
        element={
          <Workspace>
            <TransactionHistoryPage />
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
      <Route path="/" element={<Navigate to="/login" replace />} />
      <Route path="*" element={<Navigate to="/home" replace />} />
    </Routes>
  );
}
