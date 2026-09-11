import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  getCurrentUser,
  getCsrfToken,
  loginAccount,
  logoutAccount,
  refreshAccount,
  registerAccount,
  resendVerificationEmail,
  updateCurrentUser,
  verifyEmailAddress,
} from "../api/auth";
import { hasAccessToken, hasCsrfToken, setAccessToken, setCsrfToken } from "../api/client";
import {
  createContent,
  createCourse,
  deleteContentDraft,
  deleteCourseDraft,
  listContent,
  listCourses,
  listMyListings,
  submitContent,
  submitCourse,
} from "../api/catalog";
import { createCheckout, getOrder, listOrders } from "../api/commerce";
import { hasPurchasePolicy } from "../utils/purchaseDisclosure";
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
  getWallet,
  getWalletTransactions,
} from "../api/wallet";
import { normalizePortfolioUrl, parseRoleApplicationSupportingText } from "../utils/roleApplication";
import { removeListingByIdentity } from "../utils/listingWorkspace";
import { decoratePurchasedItems, purchaseMetadataByProduct } from "../utils/purchaseState";
import { loadCatalogSection } from "../utils/catalogState";
import { cartItemKey } from "../utils/purchaseDisclosure";
import { cartStorageKey, readAccountCart, mergeConfirmedOrders } from "../utils/frontendState";

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

export const mapCourse = (course) => ({
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
  onlineVideo: Boolean(course.onlineVideo || course.progressTrackingType === "online_video"),
  progressTrackingType: course.progressTrackingType || null,
  totalDurationSeconds: Number(course.totalDurationSeconds || 0),
  refundPolicyPreview: course.refundPolicyPreview || course.purchasePolicy?.refund || null,
  rating: "—",
  duration: 0,
  structure: "Course structure is provided after enrolment.",
  modules: [],
  tags: [],
  isPublished: course.status === "published",
  purchaseEnabled: course.status === "published",
  purchased: false,
});

export const mapContent = (content) => ({
  id: content.id,
  contentVersionId: content.id,
  contentId: content.contentId,
  title: content.title,
  description: content.description || content.summary || "No public description has been provided.",
  type: content.contentType || "Digital resource",
  price: Number(content.pricePoints || 0),
  creator: content.owner?.displayName || "CoLearnX creator",
  ownerId: content.owner?.id || null,
  category: content.category?.name || "General",
  rating: "—",
  refundPolicyPreview: content.refundPolicyPreview || content.purchasePolicy?.refund || null,
  isPublished: content.status === "published",
  purchased: false,
});

const transactionPresentation = (transaction) => {
  const available = Number(transaction.availableDelta || 0);
  const frozen = Number(transaction.frozenDelta || 0);
  const expired = Number(transaction.expiredDelta || 0);
  const blocked = Number(transaction.blockedDelta || 0);
  const deltas = { available, frozen, expired, blocked };
  const amount = available + frozen + expired + blocked;
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
    deltas,
    balancesAfter: { available: transaction.availableBalanceAfter ?? transaction.balanceAfter?.available ?? null, frozen: transaction.frozenBalanceAfter ?? transaction.balanceAfter?.frozen ?? null, expired: transaction.expiredBalanceAfter ?? transaction.balanceAfter?.expired ?? null, blocked: transaction.blockedBalanceAfter ?? transaction.balanceAfter?.blocked ?? null },
    orderReference: transaction.orderReference || transaction.orderId || "",
    refundReference: transaction.refundReference || transaction.refundRequestId || "",
    balance: transaction.availableBalanceAfter ?? transaction.balanceAfter?.available ?? null,
    status: transaction.status ? titleCase(transaction.status) : "Not supplied",
  };
};

const mapOrder = (order) => ({
  id: order.id,
  orderNo: order.orderNo,
  createdAt: order.createdAt,
  paidAt: order.paidAt,
  transactionReference: order.transactionReference || order.paymentTransaction?.reference || "",
  total: Number(order.totalPoints || 0),
  remainingBalance: null,
  status: titleCase(order.status),
  items: (order.items || []).map((item) => ({
    id: item.id,
    kind: item.kind,
    productId: item.productId,
    title: item.title,
    price: Number(item.pricePoints || 0),
    seller: item.seller?.displayName || item.sellerName || item.trainer || item.creator || "Seller recorded in order",
    trainer: item.seller?.displayName || item.sellerName || item.trainer || "",
    delivery: deliveryLabel(item.deliveryModes),
    deliveryModes: item.deliveryModes || [],
    refundPolicy: item.refundPolicy?.summary || item.refundPolicySnapshot?.summary || item.refundPolicySnapshot?.description || (typeof item.refundPolicy === "string" ? item.refundPolicy : "Refund snapshot text was not supplied."),
    refundPolicySnapshot: item.refundPolicySnapshot || item.refundPolicy || null,
    refundDeadlineAt: item.refundDeadlineAt,
    fulfilmentStatus: item.fulfilmentStatus,
    fulfilment: item.fulfilment || item.deliverySnapshot || null,
    fulfilmentInstructions: item.fulfilmentInstructions || item.fulfilment?.instructions || "",
    trainerContact: item.trainerContact || item.fulfilment?.trainerContact || "",
    joinUrl: item.joinUrl || item.fulfilment?.joinUrl || "",
    onlineVideo: Boolean(item.onlineVideo || item.progressTrackingType === "online_video"),
    watchedSeconds: Number(item.watchedSeconds || item.progress?.watchedSeconds || 0),
    totalDurationSeconds: Number(item.totalDurationSeconds || item.progress?.totalDurationSeconds || 0),
    refundRecords: item.refundRecords || item.refunds || [],
  })),
});

const mapRoleApplication = (application) => {
  const details = parseRoleApplicationSupportingText(application.supportingText);
  return {
    id: application.id,
    type: roleLabel(application.requestedRole),
    userId: application.applicant?.id || null,
    user: application.applicant?.displayName || "Your account",
    category: details.category,
    portfolio: details.portfolio,
    portfolioUrl: normalizePortfolioUrl(details.portfolio),
    experience: details.experience,
    reason: details.reason,
    supportingText: details.raw,
    status: titleCase(application.status),
    submittedAt: application.submittedAt,
    decisionReason: application.reviewComment || "",
  };
};

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
  fulfilmentInstructions: listing.fulfilmentInstructions || "",
  trainerContact: listing.trainerContact || "",
  joinUrl: listing.joinUrl || "",
  onlineVideo: Boolean(listing.onlineVideo || listing.progressTrackingType === "online_video"),
  totalDurationSeconds: listing.totalDurationSeconds || "",
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
  contentVersionId: listing.contentVersionId || null,
  fileStatus: listing.fileStatus || "missing",
  asset: listing.asset || null,
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
  const [courses, setCourses] = useState([]);
  const [contents, setContents] = useState([]);
  const [courseCatalogState, setCourseCatalogState] = useState({ status: "loading", error: "" });
  const [contentCatalogState, setContentCatalogState] = useState({ status: "loading", error: "" });
  const catalogRequest = useRef(null);
  const [cart, setCart] = useState([]);
  const [cartOwner, setCartOwner] = useState("");
  const accountId = useRef("");
  const sessionRevision = useRef(0);
  const confirmedOrders = useRef([]);
  const pendingCheckout = useRef(null);
  const datasetRequests = useRef({});
  const [orders, setOrders] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [applications, setApplications] = useState({ Trainer: "Not applied", Creator: "Not applied" });
  const [roleApplications, setRoleApplications] = useState([]);
  const [refundRequests, setRefundRequests] = useState([]);
  const [publishedItems, setPublishedItems] = useState([]);
  const [trainerCertifications, setTrainerCertifications] = useState([]);
  const [accountLoading, setAccountLoading] = useState(true);
  const [capabilities, setCapabilities] = useState({});
  const [dataErrors, setDataErrors] = useState({});
  const [dataStates, setDataStates] = useState({ wallet: "loading", orders: "loading", applications: "loading", listings: "loading", certification: "loading", admin: "loading" });
  const [accountError, setAccountError] = useState("");
  const [purchaseSyncWarning, setPurchaseSyncWarning] = useState("");
  const [toast, setToast] = useState("");
  const adminRoleRequestRevision = useRef(0);
  const ordersRequestRevision = useRef(0);

  const notify = useCallback((message) => {
    setToast(message);
    window.clearTimeout(window.__colearnxToast);
    window.__colearnxToast = window.setTimeout(() => setToast(""), 3200);
  }, []);

  useEffect(() => {
    if (!cartOwner || cartOwner !== accountId.current) return;
    try { window.localStorage.setItem(cartStorageKey(cartOwner), JSON.stringify(cart)); }
    catch { notify("Your browser could not save the cart. Keep this tab open until checkout."); }
  }, [cart, cartOwner, notify]);

  const trackDataset = useCallback(async (name, task) => {
    const revision = sessionRevision.current;
    const request = (datasetRequests.current[name] || 0) + 1;
    datasetRequests.current[name] = request;
    setDataStates((current) => ({ ...current, [name]: "loading" }));
    try {
      const result = await task();
      if (revision === sessionRevision.current && datasetRequests.current[name] === request) {
        setDataStates((current) => ({ ...current, [name]: "ready" }));
        setDataErrors((current) => { const next = { ...current }; delete next[name]; return next; });
      }
      return result;
    } catch (error) {
      if (revision === sessionRevision.current && datasetRequests.current[name] === request) {
        setDataStates((current) => ({ ...current, [name]: "error" }));
        setDataErrors((current) => ({ ...current, [name]: error.message || "Could not refresh this section." }));
      }
      throw error;
    }
  }, []);

  const refreshCatalog = useCallback(async () => {
    if (catalogRequest.current) return (await catalogRequest.current).every(Boolean);
    const request = Promise.all([
      loadCatalogSection({ fetchItems: listCourses, mapItem: mapCourse, setItems: setCourses, setState: setCourseCatalogState }),
      loadCatalogSection({ fetchItems: listContent, mapItem: mapContent, setItems: setContents, setState: setContentCatalogState }),
    ]);
    catalogRequest.current = request;
    try {
      const results = await request;
      return results.every(Boolean);
    } finally { catalogRequest.current = null; }
  }, []);

  const refreshWallet = useCallback(() => trackDataset("wallet", async () => {
    const revision = sessionRevision.current;
    const [wallet, ledger] = await Promise.all([getWallet(), getWalletTransactions()]);
    const nextWallet = {
      available: Number(wallet.availablePoints || 0),
      frozen: Number(wallet.frozenPoints || 0),
      expired: Number(wallet.expiredPoints || 0),
      blocked: Number(wallet.blockedPoints || 0),
    };
    if (revision !== sessionRevision.current) return nextWallet;
    setServerWallet(nextWallet);
    setBalance(nextWallet.available);
    setTransactions(ledger.map(transactionPresentation));
    return nextWallet;
  }), [trackDataset]);

  const refreshOrders = useCallback(() => trackDataset("orders", async () => {
    const requestRevision = ++ordersRequestRevision.current;
    const summaries = await listOrders();
    const details = await Promise.all(summaries.map((order) => getOrder(order.id)));
    const nextOrders = details.map(mapOrder);
    if (requestRevision !== ordersRequestRevision.current) return [];
    setOrders(mergeConfirmedOrders(nextOrders, confirmedOrders.current));
    const acknowledgedIds = new Set(nextOrders.map((order) => order.id));
    confirmedOrders.current = confirmedOrders.current.filter((order) => !acknowledgedIds.has(order.id));
    return nextOrders;
  }), [trackDataset]);

  // Purchase presentation is derived from this account's detailed order
  // records; catalog state remains raw.
  const purchasedCourses = useMemo(
    () => decoratePurchasedItems(courses, purchaseMetadataByProduct(orders, "course")),
    [courses, orders],
  );
  const purchasedContents = useMemo(
    () => decoratePurchasedItems(contents, purchaseMetadataByProduct(orders, "content")),
    [contents, orders],
  );

  const refreshMyApplications = useCallback(async () => {
    const revision = sessionRevision.current;
    const records = await getMyRoleApplications();
    const formatted = records.map(mapRoleApplication);
    if (revision !== sessionRevision.current) return [];
    setRoleApplications(formatted);
    const next = { Trainer: "Not applied", Creator: "Not applied" };
    formatted.forEach((record) => {
      if (record.type === "Trainer" || record.type === "Creator") next[record.type] = record.status;
    });
    setApplications(next);
    return formatted;
  }, []);

  const refreshMyListings = useCallback(async () => {
    const revision = sessionRevision.current;
    const listings = await listMyListings();
    const formatted = listings.map(mapPublishedItem);
    if (revision !== sessionRevision.current) return [];
    setPublishedItems(formatted);
    return formatted;
  }, []);

  const refreshMyTrainerCertifications = useCallback(async () => {
    const revision = sessionRevision.current;
    const certifications = await getMyTrainerCertifications();
    if (revision !== sessionRevision.current) return [];
    setTrainerCertifications(certifications);
    return certifications;
  }, []);

  const refreshAdminRoleApplications = useCallback(async (status = "pending") => {
    const requestRevision = adminRoleRequestRevision.current + 1;
    adminRoleRequestRevision.current = requestRevision;
    const roles = await getAdminRoleApplications({ status: status || undefined });
    if (requestRevision === adminRoleRequestRevision.current) {
      setRoleApplications(roles.map(mapRoleApplication));
    }
    return roles;
  }, []);

  const refreshAdminQueues = useCallback(async () => {
    const revision = sessionRevision.current;
    const roleRequestRevision = adminRoleRequestRevision.current + 1;
    adminRoleRequestRevision.current = roleRequestRevision;
    const [rolesResult, refundsResult] = await Promise.allSettled([
      getAdminRoleApplications({ status: "pending" }),
      getAdminRefundRequests(),
    ]);
    if (rolesResult.status === "fulfilled" && roleRequestRevision === adminRoleRequestRevision.current) {
      setRoleApplications(rolesResult.value.map(mapRoleApplication));
    }
    if (refundsResult.status === "fulfilled" && revision === sessionRevision.current) setRefundRequests(refundsResult.value.map(mapRefundRequest));
    if (rolesResult.status === "rejected" && refundsResult.status === "rejected") throw rolesResult.reason;
    return {
      roles: rolesResult.status === "fulfilled" ? rolesResult.value : [],
      refunds: refundsResult.status === "fulfilled" ? refundsResult.value : [],
      errors: {
        roles: rolesResult.status === "rejected" ? rolesResult.reason : null,
        refunds: refundsResult.status === "rejected" ? refundsResult.reason : null,
      },
    };
  }, []);

  const applyServerIdentity = useCallback((user) => {
    if (!user?.id) throw new Error("The account identity is incomplete. Please sign in again.");
    if (accountId.current !== user.id) {
      sessionRevision.current += 1;
      ordersRequestRevision.current += 1;
      accountId.current = user.id;
      confirmedOrders.current = [];
      pendingCheckout.current = null;
      setOrders([]); setTransactions([]); setBalance(0);
      setPublishedItems([]); setTrainerCertifications([]); setRoleApplications([]); setRefundRequests([]);
      setApplications({ Trainer: "Not applied", Creator: "Not applied" });
      setDataErrors({}); setPurchaseSyncWarning("");
      let stored = [];
      try { stored = readAccountCart(window.localStorage, user.id); } catch { /* Storage can be disabled. */ }
      setCart(stored); setCartOwner(user.id);
    }
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
    setCapabilities(user.capabilities || {});
    setRoleState(primaryRole);
    setAuthenticated(true);
    return nextRoles;
  }, []);

  const refreshAccountData = useCallback(async (roles) => {
    const tasks = { catalog: refreshCatalog().then((ok) => { if (!ok) throw new Error("Some listings could not be refreshed."); }), wallet: refreshWallet(), orders: refreshOrders(), applications: trackDataset("applications", refreshMyApplications), listings: trackDataset("listings", () => roles.includes("Trainer") || roles.includes("Creator") ? refreshMyListings() : Promise.resolve()), certification: trackDataset("certification", () => roles.includes("Trainer") ? refreshMyTrainerCertifications() : Promise.resolve()), admin: trackDataset("admin", () => roles.includes("Admin") ? refreshAdminQueues() : Promise.resolve()) };
    const keys = Object.keys(tasks); const results = await Promise.allSettled(Object.values(tasks)); const failures = {};
    results.forEach((result, index) => { if (result.status === "rejected") failures[keys[index]] = result.reason?.message || "Could not refresh this section."; });
    return { ok: !Object.keys(failures).length, failures };
  }, [refreshAdminQueues, refreshCatalog, refreshMyApplications, refreshMyListings, refreshMyTrainerCertifications, refreshOrders, refreshWallet, trackDataset]);

  const restoreSession = useCallback(async () => {
    setAccountLoading(true); setAccountError("");
    try {
      if (hasAccessToken()) {
        try {
          const user = await getCurrentUser();
          const roles = applyServerIdentity(user);
          void refreshAccountData(roles);
          return true;
        } catch (error) {
          if (![401, 403].includes(error.status)) {
            setAccountError(error.message);
            return false;
          }
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
      void refreshAccountData(roles);
      return true;
    } catch (error) {
      setAccessToken("");
      setCsrfToken("");
      setAuthenticated(false);
      if (![401, 403].includes(error.status)) setAccountError(error.message);
      return false;
    } finally {
      setAccountLoading(false);
    }
  }, [applyServerIdentity, refreshAccountData]);

  useEffect(() => {
    void refreshCatalog();
    restoreSession();
  }, [refreshCatalog, restoreSession]);

  const signIn = async ({ email, password }) => {
    const result = await loginAccount({ email, password });
    ordersRequestRevision.current += 1;
    setOrders([]);
    setAccessToken(result.accessToken);
    setCsrfToken(result.csrfToken);
    const roles = applyServerIdentity(await getCurrentUser());
    void refreshAccountData(roles);
    return { roles };
  };

  const registerMember = async ({ name, email, password, passwordConfirmation, acceptedTerms, ageAcknowledged }) => {
    const result = await registerAccount({ displayName: name, email, password, passwordConfirmation, acceptedTerms, ageAcknowledged });
    return result;
  };

  const verifyRegistrationEmail = async (input) => {
    const result = await verifyEmailAddress(input);
    if (!result.authenticated || !result.user || !result.accessToken || !result.csrfToken) {
      return result;
    }

    setAccessToken(result.accessToken);
    setCsrfToken(result.csrfToken);
    const initialRoles = applyServerIdentity(result.user);
    setAccountLoading(false);

    // Verification has already succeeded and the session is usable. Secondary
    // hydration failures must not turn a consumed verification code into an error.
    let roles = initialRoles;
    try {
      roles = applyServerIdentity(await getCurrentUser());
    } catch {
      // The verified session remains valid; account data can retry later.
    }
    try {
      await refreshAccountData(roles);
    } catch {
      // Enter the workspace even if a non-auth dataset is briefly unavailable.
    }
    return result;
  };

  const resendRegistrationEmail = async (input) => resendVerificationEmail(input);

  const signOut = async () => {
    sessionRevision.current += 1;
    adminRoleRequestRevision.current += 1;
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
    ordersRequestRevision.current += 1;
    setRoleState("Member");
    setApprovedRoles(["Member"]);
    setCapabilities({});
    accountId.current = ""; confirmedOrders.current = [];
    pendingCheckout.current = null;
    setCart([]); setCartOwner(""); setAccountError(""); setDataErrors({}); setPurchaseSyncWarning("");
    setPublishedItems([]); setTrainerCertifications([]); setRoleApplications([]); setRefundRequests([]);
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

  const addToCart = (kind, id) => {
    if (!authenticated || role === "Admin" || !approvedRoles.includes("Member")) return false;
    const collection = kind === "content" ? purchasedContents : purchasedCourses;
    const item = collection.find((candidate) => candidate.id === id);
    if (!item || item.purchased || item.purchaseEnabled === false) return false;
    if (!hasPurchasePolicy(item)) {
      notify("Checkout is paused until the server supplies the exact refund-policy preview.");
      return false;
    }
    const nextItem = { kind, id, seller: item.trainer || item.creator, lastSeenPrice: item.price, policySummary: item.refundPolicyPreview?.summary || item.refundPolicyPreview?.description || "" };
    if (cart.some((entry) => cartItemKey(entry) === cartItemKey(nextItem))) {
      notify("This item is already in your cart.");
      return false;
    }
    setCart((current) => [...current, nextItem]);
    notify(`${kind === "content" ? "Resource" : "Course"} added to cart.`);
    return true;
  };

  const removeFromCart = (kind, id) => setCart((current) => current.filter((item) => cartItemKey(item) !== cartItemKey({ kind, id })));

  const checkout = async (items) => {
    if (!authenticated || role === "Admin" || !approvedRoles.includes("Member")) throw new Error("A Member account is required to purchase.");
    const catalogue = [...purchasedCourses.map((item) => ({ ...item, kind: "course" })), ...purchasedContents.map((item) => ({ ...item, kind: "content" }))];
    if (items.some((entry) => !hasPurchasePolicy(catalogue.find((item) => cartItemKey(item) === cartItemKey(entry))))) throw new Error("Review the exact refund terms before checkout.");
    if (!items.length) {
      notify("Select at least one item before checkout.");
      return null;
    }
    const signature = JSON.stringify(items.map(cartItemKey).sort());
    if (pendingCheckout.current?.signature !== signature) pendingCheckout.current = { signature, key: globalThis.crypto.randomUUID() };
    const revision = sessionRevision.current;
    const result = await createCheckout(items, pendingCheckout.current.key);
    pendingCheckout.current = null;
    if (revision !== sessionRevision.current) throw new Error("The account changed during checkout. Check the original account's order history before retrying payment.");
    const order = mapOrder(result);
    ordersRequestRevision.current += 1;
    confirmedOrders.current = [order, ...confirmedOrders.current.filter((item) => item.id !== order.id)];
    setOrders((current) => [order, ...current.filter((item) => item.id !== order.id)]);
    const purchasedKeys = new Set(items.map(cartItemKey));
    setCart((current) => current.filter((item) => !purchasedKeys.has(cartItemKey(item))));
    setPurchaseSyncWarning("");
    notify("Payment succeeded. Your order has been recorded.");
    void Promise.allSettled([refreshWallet(), refreshCatalog(), refreshOrders()]).then((results) => {
      if (results.some((entry) => entry.status === "rejected" || entry.value === false)) setPurchaseSyncWarning("Payment succeeded, but some account data could not refresh. Your receipt is safe; retry synchronisation below.");
    });
    return order;
  };

  const buyContent = async (contentId) => checkout([{ kind: "content", id: contentId }]);

  const retryPurchaseSync = async () => {
    const results = await Promise.allSettled([refreshWallet(), refreshCatalog(), refreshOrders()]);
    if (results.some((entry) => entry.status === "rejected" || entry.value === false)) return false;
    setPurchaseSyncWarning(""); notify("Account data is synchronised."); return true;
  };

  const retryAccountData = async () => {
    const result = await refreshAccountData(approvedRoles);
    if (result.ok) notify("Workspace data refreshed.");
    return result.ok;
  };

  const submitRefund = async ({ course, reason }) => {
    if (!course?.orderItemId) {
      notify("The server record for this purchase is not available yet. Refresh and try again.");
      return null;
    }
    const result = await createRefundRequest({ orderItemId: course.orderItemId, reason });
    await refreshOrders();
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
    setRoleApplications((current) => current.map((application) => application.id === applicationId
      ? { ...application, status: titleCase(status), decisionReason }
      : application));
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
          fulfilmentInstructions: input.fulfilmentInstructions || null,
          trainerContact: input.trainerContact || null,
          joinUrl: input.joinUrl || null,
          progressTrackingType: input.onlineVideo ? "online_video" : "none",
          totalDurationSeconds: input.onlineVideo ? Number(input.totalDurationSeconds || 0) : null,
        }
      : {
          title: input.title,
          description: input.description || "",
          contentType: input.format || "digital",
          pricePoints: Number(input.price),
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

  const deleteDraftListing = useCallback(async (listing) => {
    if (!listing?.id || !["course", "content"].includes(listing.kind)) {
      throw new Error("This listing is not a deletable draft.");
    }
    const result = listing.kind === "course"
      ? await deleteCourseDraft(listing.id)
      : await deleteContentDraft(listing.id);
    setPublishedItems((current) => removeListingByIdentity(current, listing));
    try {
      await refreshMyListings();
      notify("Draft deleted. Any attached private files are queued for secure cleanup.");
    } catch {
      notify("Draft deleted. The list will resync the next time it is refreshed.");
    }
    return result;
  }, [notify, refreshMyListings]);

  const deletePublishedItem = () => {
    notify("Only drafts can be deleted. Published and submitted listings are retained for review and records.");
    return false;
  };
  const unavailableDeliveryAction = () => {
    notify("Secure content delivery and learning-progress tracking are not configured yet.");
    return false;
  };

  const trainerOperational = Boolean(capabilities.canCreateCourse ?? capabilities.trainerOperational ?? trainerCertifications.some((item) => String(item.status).toLowerCase() === "approved"));
  const canPurchase = role !== "Admin" && approvedRoles.includes("Member");

  const value = useMemo(() => ({
    role,
    authenticated,
    approvedRoles,
    capabilities,
    canPurchase,
    trainerOperational,
    setRole,
    balance,
    walletBalances: serverWallet,
    accountLoading,
    accountError,
    retrySession: restoreSession,
    dataStates,
    dataErrors,
    purchaseSyncWarning,
    cart,
    courses: purchasedCourses,
    contents: purchasedContents,
    courseCatalogState,
    contentCatalogState,
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
    verifyRegistrationEmail,
    resendRegistrationEmail,
    signOut,
    refreshWallet,
    refreshCatalog,
    refreshOrders,
    refreshMyApplications,
    refreshMyListings,
    refreshMyTrainerCertifications,
    refreshAdminRoleApplications,
    refreshAdminQueues,
    retryAccountData,
    addToCart,
    removeFromCart,
    buyContent,
    checkout,
    retryPurchaseSync,
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
    deleteDraftListing,
    deletePublishedItem,
  }), [
    accountLoading, accountError, dataStates, restoreSession, approvedRoles, applications, authenticated, balance, canPurchase, capabilities, cart, contents, courses, courseCatalogState, contentCatalogState, dataErrors, deleteDraftListing,
    notify, orders, profile, publishedItems, refundRequests, refreshAdminQueues, refreshAdminRoleApplications, refreshCatalog,
    refreshMyApplications, refreshMyListings, refreshMyTrainerCertifications, refreshOrders, refreshWallet, role, roleApplications, serverWallet,
    purchaseSyncWarning, purchasedContents, purchasedCourses, toast, trainerCertifications, trainerOperational, transactions,
  ]);

  return <PlatformContext.Provider value={value}>{children}</PlatformContext.Provider>;
}

export const usePlatform = () => useContext(PlatformContext);
