import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { clearStepUpAuthorization, registerStepUpHandler, withStepUp } from "./stepUp.js";
let cleanup = () => {};
afterEach(() => { cleanup(); clearStepUpAuthorization(); });
const authorization = token => ({ stepUpToken: token, expiresInSeconds: 300 });

test("parallel sensitive actions share one prompt and use an in-memory token", async () => {
  let prompts = 0;
  cleanup = registerStepUpHandler(async () => { prompts++; return authorization("factor-proof"); });
  assert.deepEqual(await Promise.all([withStepUp(async t=>t), withStepUp(async t=>t)]), ["factor-proof", "factor-proof"]);
  assert.equal(await withStepUp(async t=>t), "factor-proof");
  assert.equal(prompts, 1);
});

test("server rejection invalidates the proof and retries the same action only once", async () => {
  let prompts = 0, actions = 0;
  cleanup = registerStepUpHandler(async () => authorization(`proof-${++prompts}`));
  assert.equal(await withStepUp(async token => {
    actions++; if (actions === 1) throw Object.assign(new Error("expired"), { code: "STEP_UP_REQUIRED" });
    return token;
  }), "proof-2");
  assert.equal(prompts, 2); assert.equal(actions, 2);
  await assert.rejects(withStepUp(async () => { throw Object.assign(new Error("expired"), { code: "STEP_UP_REQUIRED" }); }));
  assert.equal(prompts, 3);
});

test("cancelling verification never executes the business action", async () => {
  cleanup = registerStepUpHandler(async () => { throw Object.assign(new Error("cancelled"), { code: "STEP_UP_CANCELLED" }); });
  let actions = 0;
  await assert.rejects(withStepUp(async () => actions++), error=>error.code === "STEP_UP_CANCELLED");
  assert.equal(actions, 0);
});

test("a late verification response after an account change cannot execute or cache an action", async () => {
  let finish, actions = 0;
  cleanup = registerStepUpHandler(()=>new Promise(resolve=>{ finish = resolve; }));
  const pending = withStepUp(async () => actions++);
  const rejected = assert.rejects(pending, error=>error.code === "SESSION_CHANGED");
  await new Promise(resolve=>setImmediate(resolve));
  clearStepUpAuthorization(); finish(authorization("old-account")); await rejected;
  assert.equal(actions, 0);
  cleanup(); cleanup = registerStepUpHandler(async()=>authorization("new-account"));
  assert.equal(await withStepUp(async t=>t), "new-account");
});

test("an expired cached proof requires another prompt", async () => {
  let prompts = 0;
  cleanup = registerStepUpHandler(async()=>({stepUpToken:`proof-${++prompts}`, expiresInSeconds:1}));
  assert.equal(await withStepUp(async t=>t), "proof-1");
  assert.equal(await withStepUp(async t=>t), "proof-2");
});
