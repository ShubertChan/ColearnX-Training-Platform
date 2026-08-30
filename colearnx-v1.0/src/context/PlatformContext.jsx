import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  getCurrentUser,
  getCsrfToken,
  loginAccount,
  logoutAccount,
  refreshAccount,
  registerAccount,
  updateCurrentUser,
} from "../api/auth";
import { hasAccessToken, hasCsrfToken, setAccessToken, setCsrfToken } from "../api/client";
import {
  createContent,
  createCourse,
  listContent,
  listCourses,
  listMyListings,
  submitContent,
  submitCourse,
} from "../api/catalog";
import { createCheckout, getOrder, listOrders } from "../api/commerce";
import {
  createRoleApplication,
  createTrainerCertification,
  decideRoleApplication as decideRoleApplicationApi,
  decideTrainerCertification as decideTrainerCertificationApi,
  getAdminRoleApplications,
  getMyTrainerCertifications,
  getMyRoleApplications,
} from "../api/governance";
import {
  createRefundRequest,
  decideRefundRequest,
  getAdminRefundRequests,
} from "../api/refunds";
import {
  getTopUpPackages,
  getWallet,
  getWalletTransactions,
} from "../api/wallet";

const PlatformContext = createContext(null);

const roleLabels = {
  member: "Member",
  trainer: "Trainer",
  creator: "Creator",
  admin: "Admin",
};

const roleLabel = (role) => roleLabels[role] || "Member";
const titleCase = (value) =>
  String(value || "").replace(/(^|_)([a-z])/g, (_match, _prefix, letter) =>
    letter.toUpperCase(),
  );
const deliveryLabel = (modes = []) =>
  modes.map((mode) => titleCase(mode)).join(" + ") || "Not specified";

const mapCourse = (course) => ({
  id: course.id,
  courseId: course.courseId,
  title: course.title,
  description: course.description || "No public description has been provided.",
  price: Number(course.pricePoints || 0),
  trainer: course.owner?.displayName || "CoLearnX instructor",
  ownerId: course.owner?.id || null,
  category: course.category?.name || "General",
  deliveryModes: Array.isArray(course.deliveryModes) ? course.deliveryModes : [],
  format: deliveryLabel(course.deliveryModes),
  delivery: deliveryLabel(course.deliveryModes),
  capacity: course.capacity,
  startsAt: course.startsAt,
  endsAt: course.endsAt,
  rating: "—",
  duration: 0,
  structure: "Course structure is provided after enrolment.",
  modules: [],
  tags: [],
  isPublished: course.status === "published",
  purchaseEnabled: course.status === "published",
  purchased: false,
});

const mapContent = (content) => ({
  id: content.id,
  contentId: content.contentId,
  title: content.title,
  description: "No public description has been provided.",
  type: content.contentType || "Digital resource",
  price: Number(content.pricePoints || 0),
  creator: content.owner?.displayName || "CoLearnX creator",
  ownerId: content.owner?.id || null,
  category: content.category?.name || "General",
  rating: "—",
  isPublished: content.status === "published",
  purchased: false,
});

const transactionPresentation = (transaction) => {
  const available = Number(transaction.availableDelta || 0);
  const frozen = Number(transaction.frozenDelta || 0);
  const expired = Number(transaction.expiredDelta || 0);
  const blocked = Number(transaction.blockedDelta || 0);
  const amount = available || frozen || expired || blocked;
  const category =
    transaction.type === "topup"
      ? "Top-up"
      : transaction.type === "refund"
        ? "Refund"
        : transaction.type === "live_hold"
          ? "Frozen"
          : transaction.type === "admin_adjustment"
            ? "Admin adjustment"
            : "Spending";
  return {
    id: transaction.id,
    createdAt: transaction.createdAt,
    type: String(transaction.type || "transaction").replaceAll("_", " "),
    item: String(transaction.reference || "CoLearnX transaction").replaceAll("_", " "),
    category,
    amount,
    balance: "Server ledger",
    status: "Completed",
  };
};

const mapOrder = (order) => ({
  id: order.id,
  orderNo: order.orderNo,
  createdAt: order.createdAt,
  paidAt: order.paidAt,
  transactionReference: order.orderNo,
  total: Number(order.totalPoints || 0),
  remainingBalance: null,
  status: titleCase(order.status),
  items: (order.items || []).map((item) => ({
    id: item.id,
    kind: item.kind,
    productId: item.productId,
    title: item.title,
    price: Number(item.pricePoints || 0),
    trainer: "",
    delivery: deliveryLabel(item.deliveryModes),
    deliveryModes: item.deliveryModes || [],
    refundPolicy: item.refundPolicy?.summary || "Refund policy is recorded with this order.",
    refundDeadlineAt: item.refundDeadlineAt,
    fulfilmentStatus: item.fulfilmentStatus,
  })),
});

const mapRoleApplication = (application) => ({
  id: application.id,
  type: roleLabel(application.requestedRole),
  userId: application.applicant?.id || null,
  user: application.applicant?.displayName || "Your account",
  category: "",
  portfolio: "",
  experience: "",
  reason: application.supportingText || "",
  status: titleCase(application.status),
  submittedAt: application.submittedAt,
  decisionReason: application.reviewComment || "",
});

const mapRefundRequest = (request) => ({
  id: request.id,
  userId: request.requester?.id || null,
  user: request.requester?.displayName || "Member",
  courseId: request.item?.id || null,
  course: request.item?.title || "Purchased item",
  basis: request.eligibility?.explanation || request.policyCode || "Recorded server policy",
  paid: Number(request.requestedPoints || 0),
  eligibility: request.eligibility?.eligible ? "Eligible" : "Recorded",
  reason: request.reason,
  status: titleCase(request.status),
  submittedAt: request.requestedAt,
  decisionReason: request.decisionReason || "",
});

const mapPublishedItem = (listing) => ({
  id: listing.id,
  kind: listing.kind,
  marketplaceId: listing.id,
  title: listing.title,
  description: listing.description || "",
  category: "General",
  format: listing.contentType || deliveryLabel(listing.deliveryModes),
  price: Number(listing.pricePoints || 0),
  capacity: listing.capacity,
  startsAt: listing.startsAt,
  endsAt: listing.endsAt,
  deliveryModes: listing.deliveryModes || [],
  status: titleCase(listing.status),
  publicationStatus: titleCase(listing.publicationStatus || listing.status),
  versionStatus: titleCase(listing.versionStatus || ""),
  storageUrlPresent: listing.storageUrlPresent,
  updatedAt: listing.updatedAt,
});

export function PlatformProvider({ children }) {
  const [authenticated, setAuthenticated] = useState(hasAccessToken());
  const [role, setRoleState] = useState("Member");
  const [approvedRoles, setApprovedRoles] = useState(["Member"]);
  const [profile, setProfile] = useState({ name: "", email: "", phone: "", location: "", bio: "" });
  const [balance, setBalance] = useState(0);
  const [serverWallet, setServerWallet] = useState({ available: 0, frozen: 0, expired: 0, blocked: 0 });
  const [topUpPackages, setTopUpPackages] = useState([]);
  const [courses, setCourses] = useState([]);
  const [contents, setContents] = useState([]);
  const [cart, setCart] = useState([]);
  const [orders, setOrders] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [applications, setApplications] = useState({ Trainer: "Not applied", Creator: "Not applied" });
  const [roleApplications, setRoleApplications] = useState([]);
  const [refundRequests, setRefundRequests] = useState([]);
  const [publishedItems, setPublishedItems] = useState([]);
  const [trainerCertifications, setTrainerCertifications] = useState([]);
  const [accountLoading, setAccountLoading] = useState(true);
  const [toast, setToast] = useState("");

  const notify = useCallback((message) => {
    setToast(message);
    window.clearTimeout(window.__colearnxToast);
    window.__colearnxToast = window.setTimeout(() => setToast(""), 3200);
  }, []);

  const refreshCatalog = useCallback(async () => {
    const [courseData, contentData] = await Promise.all([listCourses(), listContent()]);
    setCourses(courseData.map(mapCourse));
    setContents(contentData.map(mapContent));
  }, []);

  const refreshWallet = useCallback(async () => {
    const [wallet, ledger] = await Promise.all([getWallet(), getWalletTransactions()]);
    const nextWallet = {
      available: Number(wallet.availablePoints || 0),
      frozen: Number(wallet.frozenPoints || 0),
      expired: Number(wallet.expiredPoints || 0),
      blocked: Number(wallet.blockedPoints || 0),
    };
    setServerWallet(nextWallet);
    setBalance(nextWallet.available);
    setTransactions(ledger.map(transactionPresentation));
    return nextWallet;
  }, []);

  const refreshOrders = useCallback(async () => {
    const summaries = await listOrders();
    const details = await Promise.all(summaries.map((order) => getOrder(order.id)));
    const nextOrders = details.map(mapOrder);
    const coursePurchases = new Map();
    const contentPurchases = new Map();
    nextOrders.forEach((order) => {
      order.items.forEach((item) => {
        const metadata = {
          purchased: item.fulfilmentStatus !== "refunded",
          purchasedAt: order.paidAt || order.createdAt,
          orderItemId: item.id,
          orderId: order.id,
          refundStatus: item.fulfilmentStatus === "refunded" ? "Approved" : null,
        };
        if (item.kind === "course") coursePurchases.set(item.productId, metadata);
        if (item.kind === "content") contentPurchases.set(item.productId, metadata);
      });
    });
    setOrders(nextOrders);
    setCourses((current) => current.map((course) => ({ ...course, ...(coursePurchases.get(course.id) || {}) })));
    setContents((current) => current.map((content) => ({ ...content, ...(contentPurchases.get(content.id) || {}) })));
    return nextOrders;
  }, []);

  const refreshMyApplications = useCallback(async () => {
    const records = await getMyRoleApplications();
    const formatted = records.map(mapRoleApplication);
    setRoleApplications(formatted);
    const next = { Trainer: "Not applied", Creator: "Not applied" };
    formatted.forEach((record) => {
      if (record.type === "Trainer" || record.type === "Creator") next[record.type] = record.status;
    });
    setApplications(next);
    return formatted;
  }, []);

  const refreshMyListings = useCallback(async () => {
    const listings = await listMyListings();
    const formatted = listings.map(mapPublishedItem);
    setPublishedItems(formatted);
    return formatted;
  }, []);

  const refreshMyTrainerCertifications = useCallback(async () => {
    const certifications = await getMyTrainerCertifications();
    setTrainerCertifications(certifications);
    return certifications;
  }, []);

  const refreshAdminQueues = useCallback(async () => {
    const [roles, refunds] = await Promise.all([getAdminRoleApplications(), getAdminRefundRequests()]);
    setRoleApplications(roles.map(mapRoleApplication));
    setRefundRequests(refunds.map(mapRefundRequest));
    return { roles, refunds };
  }, []);

  const applyServerIdentity = useCallback((user) => {
    const granted = (user.roles || []).map(roleLabel);
    const nextRoles = granted.length ? granted : ["Member"];
    const primaryRole = nextRoles.includes("Admin")
      ? "Admin"
      : nextRoles.includes("Trainer")
        ? "Trainer"
        : nextRoles.includes("Creator")
          ? "Creator"
          : "Member";
    setProfile({
      name: user.profile?.displayName || user.fullName || user.email,
      email: user.email || "",
      phone: user.profile?.phone || "",
      location: user.profile?.location || "",
      bio: user.profile?.bio || "",
    });
    setApprovedRoles(nextRoles);
    setRoleState(primaryRole);
    setAuthenticated(true);
    return nextRoles;
  }, []);

  const refreshAccountData = useCallback(async (roles) => {
    await refreshCatalog();
    await Promise.all([refreshWallet(), refreshOrders(), refreshMyApplications()]);
    if (roles.includes("Trainer") || roles.includes("Creator"))
      await refreshMyListings();
    if (roles.includes("Trainer")) await refreshMyTrainerCertifications();
    if (roles.includes("Admin")) {
      try {
        await refreshAdminQueues();
      } catch {
        // Individual administrator pages report a retriable error when opened.
      }
    }
  }, [refreshAdminQueues, refreshCatalog, refreshMyApplications, refreshMyListings, refreshMyTrainerCertifications, refreshOrders, refreshWallet]);

  const restoreSession = useCallback(async () => {
    try {
      if (hasAccessToken()) {
        try {
          const user = await getCurrentUser();
          const roles = applyServerIdentity(user);
          await refreshAccountData(roles);
          return true;
        } catch {
          setAccessToken("");
        }
      }
      const csrf = await getCsrfToken();
      if (!csrf.csrfToken) return false;
      setCsrfToken(csrf.csrfToken);
      const refreshed = await refreshAccount();
      setAccessToken(refreshed.accessToken);
      setCsrfToken(refreshed.csrfToken);
      const roles = applyServerIdentity(refreshed.user);
      await refreshAccountData(roles);
      return true;
    } catch {
      setAccessToken("");
      setCsrfToken("");
      setAuthenticated(false);
      return false;
    } finally {
      setAccountLoading(false);
    }
  }, [applyServerIdentity, refreshAccountData]);

  useEffect(() => {
    getTopUpPackages().then(setTopUpPackages).catch(() => setTopUpPackages([]));
    refreshCatalog().catch(() => {
      setCourses([]);
      setContents([]);
    });
    restoreSession();
  }, [refreshCatalog, restoreSession]);

  const signIn = async ({ email, password }) => {
    const result = await loginAccount({ email, password });
    setAccessToken(result.accessToken);
    setCsrfToken(result.csrfToken);
    const roles = applyServerIdentity(await getCurrentUser());
    await refreshAccountData(roles);
    return true;
  };

  const registerMember = async ({ name, email, password, passwordConfirmation, acceptedTerms, ageAcknowledged }) => {
    const result = await registerAccount({ displayName: name, email, password, passwordConfirmation, acceptedTerms, ageAcknowledged });
    setAccessToken(result.accessToken);
    setCsrfToken(result.csrfToken);
    const roles = applyServerIdentity(await getCurrentUser());
    await refreshAccountData(roles);
    return true;
  };

  const signOut = async () => {
    try {
      if (!hasCsrfToken()) {
        const csrf = await getCsrfToken();
        setCsrfToken(csrf.csrfToken);
      }
      await logoutAccount();
    } catch {
      // Clearing this device's session is still safe when the server is unavailable.
    }
    setAccessToken("");
    setCsrfToken("");
    setAuthenticated(false);
    setRoleState("Member");
    setApprovedRoles(["Member"]);
    setCart([]);
    setOrders([]);
    setTransactions([]);
    setBalance(0);
    setServerWallet({ available: 0, frozen: 0, expired: 0, blocked: 0 });
  };

  const setRole = (nextRole) => {
    if (!approvedRoles.includes(nextRole)) {
      notify(`The ${nextRole} workspace has not been assigned to your account.`);
      return false;
    }
    setRoleState(nextRole);
    return true;
  };

  const addToCart = (courseId) => {
    const course = courses.find((item) => item.id === courseId);
    if (!course || course.purchased || !course.purchaseEnabled) return false;
    if (cart.includes(courseId)) {
      notify("Course is already in your cart.");
      return false;
    }
    setCart((current) => [...current, courseId]);
    notify("Course added to cart.");
    return true;
  };

  const removeFromCart = (courseId) => setCart((current) => current.filter((id) => id !== courseId));

  const checkout = async (courseIds) => {
    const items = courseIds.map((id) => ({ kind: "course", id }));
    if (!items.length) {
      notify("Select at least one course before checkout.");
      return null;
    }
    const result = await createCheckout(items);
    setCart((current) => current.filter((id) => !courseIds.includes(id)));
    await Promise.all([refreshWallet(), refreshCatalog()]);
    const nextOrders = await refreshOrders();
    const order = nextOrders.find((item) => item.id === result.id) || mapOrder(result);
    notify("Checkout completed and recorded in your wallet.");
    return order;
  };

  const buyContent = async (contentId) => {
    const result = await createCheckout([{ kind: "content", id: contentId }]);
    await Promise.all([refreshWallet(), refreshCatalog()]);
    await refreshOrders();
    notify("Content purchase completed and recorded in your wallet.");
    return result;
  };

  const submitRefund = async ({ course, reason }) => {
    if (!course?.orderItemId) {
      notify("The server record for this purchase is not available yet. Refresh and try again.");
      return null;
    }
    const result = await createRefundRequest({ orderItemId: course.orderItemId, reason });
    setCourses((current) => current.map((item) => item.id === course.id ? { ...item, refundStatus: "Pending" } : item));
    notify("Refund request submitted for administrator review.");
    return result;
  };

  const decideRefund = async (refundRequestId, status, decisionReason) => {
    await decideRefundRequest(refundRequestId, { decision: String(status).toLowerCase(), reason: decisionReason });
    await Promise.all([refreshAdminQueues(), refreshWallet(), refreshOrders()]);
    notify(`Refund request ${String(status).toLowerCase()}.`);
    return true;
  };

  const applyFor = async (type, form) => {
    const supportingText = [
      form.category && `Category: ${form.category}`,
      form.portfolio && `Portfolio: ${form.portfolio}`,
      form.experience && `Experience: ${form.experience}`,
      form.reason && `Reason: ${form.reason}`,
    ].filter(Boolean).join("\n");
    const result = await createRoleApplication({
      requestedRole: String(type).toLowerCase(),
      supportingText: supportingText || "Role application submitted through CoLearnX.",
    });
    await refreshMyApplications();
    notify(`${type} application submitted for administrator review.`);
    return result;
  };

  const submitTrainerCertification = async (input) => {
    const result = await createTrainerCertification(input);
    await refreshMyTrainerCertifications();
    notify("Trainer certification submitted for administrator review.");
    return result;
  };

  const decideRoleApplication = async (applicationId, status, decisionReason) => {
    await decideRoleApplicationApi(applicationId, { decision: String(status).toLowerCase(), reason: decisionReason });
    await refreshAdminQueues();
    notify(`Role application ${String(status).toLowerCase()}.`);
    return true;
  };

  const decideTrainerCertification = async (certificationId, status, decisionReason) => {
    await decideTrainerCertificationApi(certificationId, { decision: String(status).toLowerCase(), reason: decisionReason });
    await refreshAdminQueues();
    notify(`Trainer certification ${String(status).toLowerCase()}.`);
    return true;
  };

  const saveProfile = async (nextProfile) => {
    await updateCurrentUser({
      fullName: nextProfile.name,
      phone: nextProfile.phone || null,
      location: nextProfile.location || null,
      bio: nextProfile.bio || null,
    });
    applyServerIdentity(await getCurrentUser());
    notify("Profile changes saved.");
    return true;
  };

  const savePublishedItem = async (input) => {
    const isCourse = input.kind === "course";
    const payload = isCourse
      ? {
          title: input.title,
          description: input.description || "",
          pricePoints: Number(input.price),
          capacity: input.capacity ? Number(input.capacity) : null,
          startsAt: input.startsAt || null,
          endsAt: input.endsAt || null,
          timezone: input.timezone || "Asia/Singapore",
          deliveryModes: input.deliveryModes?.length ? input.deliveryModes : ["cloud"],
        }
      : {
          title: input.title,
          contentType: input.format || "digital",
          pricePoints: Number(input.price),
          storageUrl: input.externalUrl || undefined,
        };
    const created = isCourse ? await createCourse(payload) : await createContent(payload);
    const submitted = input.status === "Published"
      ? isCourse ? await submitCourse(created.id) : await submitContent(created.id)
      : created;
    const listing = {
      ...input,
      id: created.id,
      status: submitted.status === "submitted" ? "Submitted" : "Draft",
      updatedAt: new Date().toISOString(),
      marketplaceId: created.id,
    };
    await refreshMyListings();
    notify(listing.status === "Submitted" ? "Submitted for administrator review." : "Draft created on the server.");
    return listing;
  };

  const deletePublishedItem = () => {
    notify("Deleting a listing is not available in this release.");
    return false;
  };

  const unavailableDeliveryAction = () => {
    notify("Secure content delivery and learning-progress tracking are not configured yet.");
    return false;
  };

  const value = useMemo(() => ({
    role,
    authenticated,
    approvedRoles,
    setRole,
    balance,
    walletBalances: serverWallet,
    topUpPackages,
    accountLoading,
    cart,
    courses,
    contents,
    transactions,
    applications,
    roleApplications,
    refundRequests,
    publishedItems,
    trainerCertifications,
    orders,
    lastOrder: orders[0] || null,
    profile,
    toast,
    notify,
    signIn,
    registerMember,
    signOut,
    refreshWallet,
    refreshCatalog,
    refreshOrders,
    refreshMyApplications,
    refreshMyListings,
    refreshMyTrainerCertifications,
    refreshAdminQueues,
    addToCart,
    removeFromCart,
    buyContent,
    checkout,
    downloadCourse: unavailableDeliveryAction,
    updateCourseProgress: unavailableDeliveryAction,
    submitRefund,
    decideRefund,
    applyFor,
    submitTrainerCertification,
    decideRoleApplication,
    decideTrainerCertification,
    saveProfile,
    savePublishedItem,
    deletePublishedItem,
  }), [
    accountLoading, approvedRoles, applications, authenticated, balance, cart, contents, courses,
    notify, orders, profile, publishedItems, refundRequests, refreshAdminQueues, refreshCatalog,
    refreshMyApplications, refreshMyListings, refreshMyTrainerCertifications, refreshOrders, refreshWallet, role, roleApplications, serverWallet,
    toast, topUpPackages, trainerCertifications, transactions,
  ]);

  return <PlatformContext.Provider value={value}>{children}</PlatformContext.Provider>;
}

export const usePlatform = () => useContext(PlatformContext);
