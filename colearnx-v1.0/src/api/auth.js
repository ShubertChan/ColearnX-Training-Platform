import { apiClient } from "./client";

const unwrap = (response) => response.data.data;
export const registerAccount = (input) => apiClient.post("/auth/register", input).then(unwrap);
export const verifyEmailAddress = (input) => apiClient.post("/auth/verify-email", input).then(unwrap);
export const resendVerificationEmail = (input) => apiClient.post("/auth/resend-verification", input).then(unwrap);
export const loginAccount = (input) => apiClient.post("/auth/login", input).then(unwrap);
export const getCsrfToken = () => apiClient.get("/auth/csrf").then(unwrap);
export const refreshAccount = () => apiClient.post("/auth/refresh").then(unwrap);
export const logoutAccount = () => apiClient.post("/auth/logout").then(unwrap);
export const getCurrentUser = () => apiClient.get("/me").then(unwrap);
export const updateCurrentUser = (input) => apiClient.patch("/me", input).then(unwrap);
export const requestPasswordReset = (input) => apiClient.post("/auth/forgot-password", input).then(unwrap);
export const resetPassword = (input) => apiClient.post("/auth/reset-password", input).then(unwrap);

// --- W4 multi-factor authentication -----------------------------------------
export const completeMfaLogin = (input) => apiClient.post("/auth/mfa/verify", input).then(unwrap);
export const getMfaStatus = () => apiClient.get("/auth/mfa").then(unwrap);
export const startMfaEnrolment = () => apiClient.post("/auth/mfa/enrol").then(unwrap);
export const confirmMfaEnrolment = (input) => apiClient.post("/auth/mfa/confirm", input).then(unwrap);
export const disableMfa = (input) => apiClient.post("/auth/mfa/disable", input).then(unwrap);
export const rotateRecoveryCodes = (input) => apiClient.post("/auth/mfa/recovery-codes", input).then(unwrap);
export const requestStepUp = (input, options) => apiClient.post("/auth/step-up", input, options).then(unwrap);

// --- W4 session management --------------------------------------------------
export const listSessions = () => apiClient.get("/auth/sessions").then(unwrap);
export const revokeSession = (id) => apiClient.delete(`/auth/sessions/${id}`).then(unwrap);
export const revokeOtherSessions = () => apiClient.post("/auth/sessions/revoke-others").then(unwrap);
