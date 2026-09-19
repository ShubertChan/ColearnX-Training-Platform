// A short-lived authorization stays in this tab's memory only. Account changes
// abort the prompt and invalidate queued actions as well as the cached token.
let handler = null, cached = null, pending = null, generation = 0;
const changed = () => Object.assign(new Error("Your account session changed. Please try again."), { code: "SESSION_CHANGED" });

export function clearStepUpAuthorization() {
  generation++;
  cached = null;
  pending?.controller.abort();
  pending = null;
}

export function registerStepUpHandler(requestAuthorization) {
  handler = requestAuthorization;
  return () => {
    if (handler !== requestAuthorization) return;
    clearStepUpAuthorization();
    handler = null;
  };
}

async function authorize() {
  if (cached?.expiresAt > Date.now()) return cached.token;
  if (pending) return pending.promise;
  if (!handler) throw new Error("Open the administrator workspace to confirm your identity.");
  const revision = generation, controller = new AbortController();
  const request = { controller };
  request.promise = Promise.resolve().then(() => {
    if (revision !== generation) throw changed();
    return handler(controller.signal);
  }).then(result => {
    if (revision !== generation) throw changed();
    if (!result?.stepUpToken || !Number.isFinite(result.expiresInSeconds) || result.expiresInSeconds <= 0) {
      throw new Error("Identity verification returned an incomplete response. Please try again.");
    }
    cached = { token: result.stepUpToken, expiresAt: Date.now() + Math.max(0, result.expiresInSeconds - 5) * 1000 };
    return cached.token;
  }).finally(() => { if (pending === request) pending = null; });
  pending = request;
  return request.promise;
}

export async function withStepUp(action) {
  const revision = generation;
  let token = await authorize();
  if (revision !== generation) throw changed();
  try { return await action(token); }
  catch (error) {
    if (revision !== generation) throw changed();
    if (error.code !== "STEP_UP_REQUIRED") throw error;
    // A server-side expiry/rejection requires a fresh factor, not an auth refresh
    // loop. Preserve the original action and its idempotency key for one retry.
    if (cached?.token === token) cached = null;
    token = await authorize();
    if (revision !== generation) throw changed();
    return action(token);
  }
}
