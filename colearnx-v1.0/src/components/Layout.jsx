import { useEffect, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  BadgeCheck,
  BookOpen,
  BriefcaseBusiness,
  ChevronDown,
  CircleUserRound,
  ClipboardCheck,
  FileText,
  GraduationCap,
  History,
  Home,
  LayoutDashboard,
  Library,
  LogOut,
  Menu,
  ReceiptText,
  ShoppingCart,
  Store,
  UserCheck,
  WalletCards,
  X,
} from "lucide-react";
import { usePlatform } from "../context/PlatformContext";

const baseNavigation = [
  ["/home", "Home", Home],
  ["/courses", "Course Marketplace", GraduationCap],
  ["/contents", "Content Marketplace", Store],
  ["/cart", "Shopping Cart", ShoppingCart],
  ["/purchases", "My Learning", Library],
  ["/orders", "Order History", ReceiptText],
  ["/wallet", "Points Wallet", WalletCards],
  ["/transactions", "Transaction History", History],
  ["/role-application", "Role Application", BadgeCheck],
];

const roleNavigation = {
  Trainer: [
    ["/trainer/course-editor", "Course Editor", BookOpen],
    ["/published", "Published Items", BriefcaseBusiness],
  ],
  Creator: [
    ["/creator/content-editor", "Content Editor", FileText],
    ["/published", "Published Items", BriefcaseBusiness],
  ],
  Admin: [
    ["/admin", "Admin Dashboard", LayoutDashboard],
    ["/admin/applications", "Role Applications", BadgeCheck],
    ["/admin/refunds", "Refund Review", ClipboardCheck],
    ["/admin/users", "Users & Roles", UserCheck],
    ["/admin/catalog", "Catalog Control", BookOpen],
  ],
};

const titleMap = {
  "/home": ["Home", "Your learning activity at a glance"],
  "/profile": [
    "My Profile",
    "Manage your personal information and public identity",
  ],
  "/courses": [
    "Course Marketplace",
    "Compare course formats, schedules and refund eligibility",
  ],
  "/contents": [
    "Content Marketplace",
    "Browse downloadable resources from verified creators",
  ],
  "/cart": ["Shopping Cart", "Review selected courses before checkout"],
  "/checkout-success": ["Order Details", "Review your latest course order"],
  "/purchases": [
    "My Learning",
    "Continue courses and access purchased content",
  ],
  "/orders": ["Order History", "Review individual course orders and receipts"],
  "/wallet": [
    "Points Wallet",
    "Track one balance across learning and creator activity",
  ],
  "/transactions": [
    "Transaction History",
    "Review spending, income, refunds and top-ups",
  ],
  "/role-application": [
    "Role Application",
    "Apply to teach courses or publish creative content",
  ],
  "/trainer/course-editor": [
    "Course Editor",
    "Create a clear learning offer for members",
  ],
  "/creator/content-editor": [
    "Content Editor",
    "Publish downloadable resources for learners",
  ],
  "/published": ["Published Items", "Manage your courses and creator content"],
  "/admin": ["Admin Dashboard", "Review platform activity and pending actions"],
  "/admin/applications": [
    "Role Applications",
    "Review applicant profiles, evidence and access requests",
  ],
  "/admin/refunds": [
    "Refund Review",
    "Apply the platform refund policy consistently",
  ],
  "/admin/users": ["Users & Roles", "Review accounts, permissions and access controls"],
  "/admin/catalog": ["Catalog Control", "Inspect course and content publication"],
};

function titleFor(pathname) {
  if (titleMap[pathname]) return titleMap[pathname];
  if (pathname.startsWith("/checkout-success/"))
    return ["Order Details", "Review the selected course order and receipt"];
  if (pathname.startsWith("/courses/"))
    return [
      "Course Detail",
      "Review delivery, learning structure and refund rules",
    ];
  if (pathname.startsWith("/contents/"))
    return [
      "Content Detail",
      "Review the creator, file type and purchase summary",
    ];
  if (pathname.startsWith("/public-profile/"))
    return [
      "Public Profile",
      "Review the author's credibility and published work",
    ];
  if (pathname.startsWith("/admin/users/"))
    return ["User Details", "Review an account and apply audited access controls"];
  if (pathname.startsWith("/refund/"))
    return ["Refund Request", "Confirm policy eligibility before submitting"];
  return ["CoLearnX", "Learning and creator marketplace"];
}

export default function Layout({ children }) {
  const {
    role,
    setRole,
    approvedRoles,
    balance,
    cart,
    toast,
    profile,
    signOut,
  } = usePlatform();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const [title, subtitle] = titleFor(location.pathname);
  const nav = [...baseNavigation, ...(roleNavigation[role] || [])];

  useEffect(() => setOpen(false), [location.pathname]);

  return (
    <div className="app-shell">
      {open && (
        <button
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setOpen(false)}
        />
      )}
      <aside className={`sidebar ${open ? "open" : ""}`}>
        <button
          type="button"
          className="brand"
          onClick={() => navigate("/home")}
          aria-label="Go to CoLearnX home"
        >
          <img src="./assets/next-logo.jpg" alt="neXt" />
          <div>
            <strong>CoLearnX</strong>
            <span>Learning Platform</span>
          </div>
        </button>
        <button
          className="mobile-close"
          onClick={() => setOpen(false)}
          aria-label="Close menu"
        >
          <X size={20} />
        </button>
        <nav aria-label="Primary navigation">
          {nav.map(([to, label, Icon]) => (
            <NavLink
              key={`${role}-${to}`}
              to={to}
              end={to === "/admin"}
              className={({ isActive }) => (isActive ? "active" : "")}
            >
              <Icon size={19} />
              <span>{label}</span>
              {to === "/cart" && cart.length > 0 && (
                <b className="nav-count">{cart.length}</b>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          {approvedRoles.length > 1 && (
            <label>
              <span>Workspace role</span>
              <div className="select-wrap">
                <select
                  value={role}
                  onChange={(event) => setRole(event.target.value)}
                >
                  {approvedRoles.map((approvedRole) => (
                    <option key={approvedRole} value={approvedRole}>
                      {approvedRole}
                    </option>
                  ))}
                </select>
                <ChevronDown size={15} />
              </div>
            </label>
          )}
          <button className="profile-chip" onClick={() => navigate("/profile")}>
            <span className="avatar small">
              {profile.name
                .split(" ")
                .map((part) => part[0])
                .join("")
                .slice(0, 2)
                .toUpperCase()}
            </span>
            <span>
              <b>{profile.name}</b>
              <small>{role}</small>
            </span>
            <CircleUserRound size={18} />
          </button>
          <button
            className="sidebar-signout"
            onClick={() => {
              signOut();
              navigate("/login");
            }}
          >
            <LogOut size={15} /> Sign out
          </button>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div className="topbar-title">
            <button
              className="menu-button"
              onClick={() => setOpen(true)}
              aria-label="Open menu"
            >
              <Menu size={21} />
            </button>
            <div>
              <span className="eyebrow">Workspace</span>
              <h1>{title}</h1>
              <p>{subtitle}</p>
            </div>
          </div>
          <div className="topbar-actions">
            <button
              className="balance-pill"
              onClick={() => navigate("/wallet")}
            >
              <WalletCards size={18} />
              <span>
                <b>{balance}</b> points
              </span>
            </button>
            <button
              className="icon-button"
              aria-label="Receipts"
              onClick={() => navigate("/transactions")}
            >
              <ReceiptText size={19} />
            </button>
          </div>
        </header>
        <div className="page-content">{children}</div>
      </main>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
