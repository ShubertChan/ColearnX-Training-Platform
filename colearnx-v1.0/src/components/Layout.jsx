import { useEffect, useRef, useState } from "react";
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
  AlertTriangle,
  RotateCcw,
} from "lucide-react";
import { usePlatform } from "../context/PlatformContext";
import nextLogo from "../../assets/next-logo.jpg";

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
    ["/publishing-tools", "Publishing tools", BriefcaseBusiness],
    ["/published", "Published Items", BriefcaseBusiness],
  ],
  Creator: [
    ["/creator/content-editor", "Content Editor", FileText],
    ["/publishing-tools", "Publishing tools", BriefcaseBusiness],
    ["/published", "Published Items", BriefcaseBusiness],
  ],
  Admin: [
    ["/admin", "Admin Dashboard", LayoutDashboard],
    ["/admin/operations", "Reports & Operations", ClipboardCheck],
    ["/admin/applications", "Role Applications", BadgeCheck],
    ["/admin/refunds", "Refund Review", ClipboardCheck],
    ["/admin/users", "Users & Roles", UserCheck],
    ["/admin/catalog", "Catalog Control", BookOpen],
  ],
};

const titleMap = {
  "/publishing-tools": ["Publishing tools", "Manage listings, licences, versions and usage"],
  "/admin/operations": ["Reports & Operations", "Review moderation, wallet adjustments and audit records"],
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
    dataErrors,
    retryAccountData,
  } = usePlatform();
  const [open, setOpen] = useState(false);
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 900px)").matches);
  const sidebarRef = useRef(null);
  const menuRef = useRef(null);
  const closeRef = useRef(null);
  const mainRef = useRef(null);
  const location = useLocation();
  const navigate = useNavigate();
  const [title, subtitle] = titleFor(location.pathname);
  const nav = role === "Admin" ? roleNavigation.Admin : [...baseNavigation, ...(roleNavigation[role] || [])];

  useEffect(() => setOpen(false), [location.pathname]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 900px)");
    const onChange = () => { setMobile(query.matches); setOpen(false); };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!mobile || !open) return;
    const sidebar = sidebarRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const focusable = () => [...sidebar.querySelectorAll(
      'a[href], button:not(:disabled), select:not(:disabled), [tabindex="0"]',
    )].filter((element) => element.getClientRects().length > 0);
    const onKeyDown = (event) => {
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
      if (event.key !== "Tab") return;
      const items = focusable();
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
    };
    const onFocus = (event) => {
      if (!sidebar.contains(event.target)) closeRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocus);
      queueMicrotask(() => {
        const target = window.matchMedia("(max-width: 900px)").matches
          ? menuRef.current : mainRef.current;
        if (target?.isConnected) target.focus();
      });
    };
  }, [mobile, open]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content" inert={mobile && open}
        onClick={(event) => { event.preventDefault(); mainRef.current?.focus(); }}>
        Skip to main content
      </a>
      {mobile && open && (
        <div
          className="sidebar-scrim"
          aria-hidden="true"
          onClick={() => setOpen(false)}
        />
      )}
      <aside ref={sidebarRef} id="workspace-navigation"
        className={`sidebar ${open ? "open" : ""}`}
        inert={mobile && !open} aria-hidden={mobile && !open ? true : undefined}
        role={mobile && open ? "dialog" : undefined}
        aria-modal={mobile && open ? true : undefined} aria-label="Workspace navigation">
        <button
          type="button"
          className="brand"
          onClick={() => navigate(role === "Admin" ? "/admin" : "/home")}
          aria-label="Go to CoLearnX home"
        >
          <img src={nextLogo} alt="neXt" />
          <div>
            <strong>CoLearnX</strong>
            <span>Learning Platform</span>
          </div>
        </button>
        <button
          ref={closeRef}
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
      <main ref={mainRef} id="main-content" tabIndex={-1} inert={mobile && open}>
        <header className="topbar">
          <div className="topbar-title">
            <button
              ref={menuRef}
              className="menu-button"
              onClick={() => setOpen(true)}
              aria-label="Open menu"
              aria-expanded={mobile && open}
              aria-controls="workspace-navigation"
            >
              <Menu size={21} />
            </button>
            <div>
              <h1>{title}</h1>
              <p>{subtitle}</p>
            </div>
          </div>
          <div className="topbar-actions">
            {role !== "Admin" && <>
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
            </>}
          </div>
        </header>
        <div className="page-content">
          {Object.keys(dataErrors).length > 0 && <div className="data-warning" role="status"><AlertTriangle size={18} /><div><b>Some workspace data could not be refreshed.</b><span>{Object.keys(dataErrors).join(", ")} · your signed-in session remains active.</span></div><button className="button secondary sm" onClick={() => void retryAccountData()}><RotateCcw size={14} /> Retry</button></div>}
          {children}
        </div>
      </main>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
