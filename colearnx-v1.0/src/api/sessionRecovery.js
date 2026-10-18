// Only session GETs use this cold-start allowance. Never replay a login,
// refresh-token rotation, payment or other write after an uncertain response.
export const SESSION_READ_TIMEOUT_MS = 20000;
const retryDelays = [1000, 2000, 4000];

function cancelled() {
  return Object.assign(new Error("Session recovery was cancelled."), { code: "ERR_CANCELED", status: 0 });
}

function waitForRetry(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(cancelled()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function readSessionResource(request, { signal, wait = waitForRetry } = {}) {
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw cancelled();
    try {
      return await request({ timeout: SESSION_READ_TIMEOUT_MS, signal });
    } catch (error) {
      const transient = error.code !== "ERR_CANCELED" && error.code !== "SESSION_CHANGED"
        && (error.status === 0 || [408, 502, 503, 504].includes(error.status));
      if (!transient || attempt >= retryDelays.length || signal?.aborted) throw error;
      await wait(retryDelays[attempt], signal);
    }
  }
}
