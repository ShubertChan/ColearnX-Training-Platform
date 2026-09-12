import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import pino from 'pino';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { query } from './db/database.js';
import { ApiError, errorHandler, notFound, ok } from './lib/http.js';
import { recordAccessDecision } from './security/access-log.js';
import { authenticate, csrf, forgotPassword, login, logout, me, refresh, register, resendEmailVerification, requireRole, resetPassword, updateMe, verifyEmail } from './auth/auth.js';
import { createCheckoutSession, getTopUp, stripeWebhook } from './payments/stripe.js';
import { topUpPackages, wallet, walletTransactions } from './wallet/wallet.js';
import { createContent, createCourse, decideContentSubmission, decideCourseSubmission, deleteContentDraft, deleteCourseDraft, getContent, getCourse, listContent, listContentSubmissions, listCourseSubmissions, listCourses, listMyListings, submitContent, submitCourse, updateCourse } from './catalog/catalog.js';
import { checkout, getOrder, listOrders } from './orders/commerce.js';
import { createRefundRequest, decideRefund, getRefundRequest, listRefundRequestsForAdmin } from './refunds/service.js';
import { createRoleApplication, createTrainerCertification, decideRoleApplication, decideTrainerCertification, listRoleApplications, listTrainerCertifications, myRoleApplications, myTrainerCertifications } from './governance/governance.js';
import { getPublicProfile, requestAccountDeletion, requestDataExport } from './account/privacy.js';
import { addCartItem, listCart, removeCartItem } from './cart/cart.js';
import { adjustPoints, cancelLiveCourseRun, completeLiveCourseRun, createTopUpPackage, retireTopUpPackage, setRevenueSharePolicy } from './admin/operations.js';
import { changeUserRole, deleteUser, getUser, listUsers, reinstateUser, suspendUser } from './admin/users.js';
import { completeUploadIntent, createContentDownloadUrl, createUploadIntent, deleteUploadIntent, listContentAssets, previewContentAsset } from './storage/content-assets.js';
import { completeCourseUploadIntent, createCourseDownloadUrl, createCourseUploadIntent, deleteCourseUploadIntent, getCourseDelivery, listCourseAssets, recordCourseProgress } from './storage/course-delivery.js';


const logger = pino({ level: env.LOG_LEVEL, redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body.password', 'req.body.passwordConfirmation', 'req.body.code', 'req.body.token', 'res.headers.set-cookie'] });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, handler: (_req, _res, next) => next(Object.assign(new Error('Too many authentication attempts.'), { status: 429, code: 'RATE_LIMITED' })) });
const verificationLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, handler: (_req, _res, next) => next(Object.assign(new Error('Too many verification attempts.'), { status: 429, code: 'RATE_LIMITED' })) });
const mutationLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false, handler: (_req, _res, next) => next(Object.assign(new Error('Too many requests.'), { status: 429, code: 'RATE_LIMITED' })) });
// Password reset is the highest-value unauthenticated endpoint here and is
// also an outbound email amplifier, so it gets its own budget rather than
// sharing the general auth one. The per-account cooldown in auth.ts is the
// other half: this bounds one source, that bounds one inbox.
const passwordResetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false, handler: (_req, _res, next) => next(Object.assign(new Error('Too many password reset attempts.'), { status: 429, code: 'RATE_LIMITED' })) });

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);
  app.use(pinoHttp({ logger, genReqId: (req, res) => {
    const supplied = req.headers['x-request-id'];
    const requestId = typeof supplied === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(supplied)
      ? supplied
      : randomUUID();
    res.locals.requestId = requestId;
    return requestId;
  } }));
  app.use((req, res, next) => { res.locals.requestId ||= req.id || randomUUID(); res.locals.log = req.log; next(); });
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  // A rejected origin used to be a bare Error, which reached errorHandler's
  // fallback branch and became a 500 plus an error-level log line -- letting
  // any external party generate error-severity log volume for free. It is a
  // client error, so it is typed as one.
  app.use(cors({ origin(origin, callback) { if (!origin || origin === env.APP_ORIGIN) return callback(null, true); return callback(new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'The request origin is not allowed.')); }, credentials: true, maxAge: 600 }));

  // This route deliberately precedes JSON parsing: Stripe signature verification needs the untouched body bytes.
  app.post('/api/v1/payments/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }), stripeWebhook);
  app.use(express.json({ limit: '1mb', type: 'application/json' }));
  app.use(express.urlencoded({ extended: false, limit: '20kb' }));
  app.use(cookieParser());

  app.get('/health/live', (_req, res) => ok(res, { status: 'live' }));
  app.get('/health/ready', async (_req, res, next) => {
    try { await query('SELECT 1'); return ok(res, { status: 'ready' }); } catch { return next(Object.assign(new Error('Database unavailable.'), { status: 503, code: 'DEPENDENCY_UNAVAILABLE' })); }
  });

  const api = express.Router();
  api.get('/auth/csrf', csrf);
  api.post('/auth/register', authLimiter, register);
  api.post('/auth/forgot-password', passwordResetLimiter, forgotPassword);
  api.post('/auth/reset-password', passwordResetLimiter, resetPassword);
  api.post('/auth/verify-email', verificationLimiter, verifyEmail);
  api.post('/auth/resend-verification', verificationLimiter, resendEmailVerification);
  api.post('/auth/login', authLimiter, login);
  api.post('/auth/refresh', authLimiter, refresh);
  api.get('/profiles/:id', getPublicProfile);
  api.post('/me/data-export', authenticate, mutationLimiter, requestDataExport);
  api.post('/me/deletion-requests', authenticate, mutationLimiter, requestAccountDeletion);
  api.post('/auth/logout', logout);
  api.get('/me', authenticate, me);
  api.patch('/me', authenticate, mutationLimiter, updateMe);

  api.get('/courses', listCourses);
  api.get('/courses/:id', getCourse);
  api.get('/content', listContent);
  api.get('/content/:id', getContent);
  api.get('/my/listings', authenticate, listMyListings);
  api.post('/courses', authenticate, mutationLimiter, createCourse);
  api.post('/courses/:id/submit', authenticate, mutationLimiter, submitCourse);
  api.patch('/courses/:id', authenticate, mutationLimiter, updateCourse);
  api.delete('/courses/:id/draft', authenticate, mutationLimiter, deleteCourseDraft);
  api.post('/content', authenticate, mutationLimiter, createContent);
  api.post('/content/:id/submit', authenticate, mutationLimiter, submitContent);
  api.delete('/content/:id/draft', authenticate, mutationLimiter, deleteContentDraft);
  api.get('/content-versions/:contentVersionId/assets', authenticate, listContentAssets);
  api.post('/content-versions/:contentVersionId/upload-intents', authenticate, mutationLimiter, createUploadIntent);
  api.post('/content-versions/:contentVersionId/upload-intents/:assetId/complete', authenticate, mutationLimiter, completeUploadIntent);
  api.delete('/content-versions/:contentVersionId/upload-intents/:assetId', authenticate, mutationLimiter, deleteUploadIntent);
  api.post('/content-versions/:contentVersionId/download-url', authenticate, mutationLimiter, createContentDownloadUrl);

  api.get('/courses/:courseRunId/assets', authenticate, listCourseAssets);
  api.post('/courses/:courseRunId/upload-intents', authenticate, mutationLimiter, createCourseUploadIntent);
  api.post('/courses/:courseRunId/upload-intents/:assetId/complete', authenticate, mutationLimiter, completeCourseUploadIntent);
  api.delete('/courses/:courseRunId/upload-intents/:assetId', authenticate, mutationLimiter, deleteCourseUploadIntent);
  api.post('/role-applications', authenticate, mutationLimiter, createRoleApplication);
  api.get('/role-applications/me', authenticate, myRoleApplications);
  api.post('/trainer-certifications', authenticate, mutationLimiter, createTrainerCertification);
  api.get('/trainer-certifications/me', authenticate, myTrainerCertifications);

  api.get('/wallet', authenticate, wallet);
  api.get('/wallet/transactions', authenticate, walletTransactions);
  api.get('/wallet/top-up-packages', topUpPackages);
  api.get('/cart', authenticate, listCart);
  api.post('/cart/items', authenticate, mutationLimiter, addCartItem);
  api.delete('/cart/items/:id', authenticate, mutationLimiter, removeCartItem);
  api.post('/wallet/top-ups/checkout-session', authenticate, mutationLimiter, createCheckoutSession);
  api.get('/wallet/top-ups/:id', authenticate, getTopUp);

  api.post('/checkout', authenticate, mutationLimiter, checkout);
  api.get('/orders', authenticate, listOrders);
  api.get('/orders/:id', authenticate, getOrder);
  api.post('/refund-requests', authenticate, mutationLimiter, createRefundRequest);
  api.get('/order-items/:orderItemId/delivery', authenticate, getCourseDelivery);
  api.post('/order-items/:orderItemId/delivery/download-url', authenticate, mutationLimiter, createCourseDownloadUrl);
  api.post('/order-items/:orderItemId/progress', authenticate, mutationLimiter, recordCourseProgress);
  api.get('/refund-requests/:id', authenticate, getRefundRequest);
  api.get('/admin/role-applications', authenticate, requireRole('admin'), listRoleApplications);
  api.post('/admin/role-applications/:id/decision', authenticate, requireRole('admin'), mutationLimiter, decideRoleApplication);
  api.get('/admin/trainer-certifications', authenticate, requireRole('admin'), listTrainerCertifications);
  api.post('/admin/trainer-certifications/:id/decision', authenticate, requireRole('admin'), mutationLimiter, decideTrainerCertification);
  api.get('/admin/course-submissions', authenticate, requireRole('admin'), listCourseSubmissions);
  api.post('/admin/course-runs/:id/decision', authenticate, requireRole('admin'), mutationLimiter, decideCourseSubmission);
  api.get('/admin/content-submissions', authenticate, requireRole('admin'), listContentSubmissions);
  api.post('/admin/content-versions/:id/decision', authenticate, requireRole('admin'), mutationLimiter, decideContentSubmission);
  api.post('/admin/content-versions/:contentVersionId/preview-url', authenticate, requireRole('admin'), mutationLimiter, previewContentAsset);
  api.get('/admin/refund-requests', authenticate, requireRole('admin'), listRefundRequestsForAdmin);
  api.post('/admin/refund-requests/:id/decision', authenticate, requireRole('admin'), mutationLimiter, decideRefund);
  api.get('/admin/users', authenticate, requireRole('admin'), listUsers);
  api.get('/admin/users/:id', authenticate, requireRole('admin'), getUser);
  api.post('/admin/users/:id/suspend', authenticate, requireRole('admin'), mutationLimiter, suspendUser);
  api.post('/admin/users/:id/reinstate', authenticate, requireRole('admin'), mutationLimiter, reinstateUser);
  api.post('/admin/users/:id/roles', authenticate, requireRole('admin'), mutationLimiter, changeUserRole);
  api.delete('/admin/users/:id', authenticate, requireRole('admin'), mutationLimiter, deleteUser);
  api.put('/admin/revenue-share-policies/:kind', authenticate, requireRole('admin'), mutationLimiter, setRevenueSharePolicy);
  api.post('/admin/top-up-packages', authenticate, requireRole('admin'), mutationLimiter, createTopUpPackage);
  api.post('/admin/top-up-packages/:id/retire', authenticate, requireRole('admin'), mutationLimiter, retireTopUpPackage);
  api.post('/admin/points/adjustments', authenticate, requireRole('admin'), mutationLimiter, adjustPoints);
  api.post('/admin/course-runs/:id/complete', authenticate, requireRole('admin'), mutationLimiter, completeLiveCourseRun);
  api.post('/admin/course-runs/:id/cancel', authenticate, requireRole('admin'), mutationLimiter, cancelLiveCourseRun);
  app.use('/api/v1', api);
  app.use(notFound);
  // Observes 403/429 for the security ledger, then hands the error to the
  // responder below. Ordering matters: errorHandler terminates the chain.
  app.use(recordAccessDecision);
  app.use(errorHandler);
  return app;
}
