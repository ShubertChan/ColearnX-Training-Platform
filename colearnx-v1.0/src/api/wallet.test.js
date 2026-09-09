import assert from "node:assert/strict";
import test from "node:test";
import { apiClient } from "./client.js";
import { getTopUpPackages } from "./wallet.js";

test("top-up packages unwrap the response and forward the cancellation signal", async (t) => {
  const originalGet = apiClient.get;
  t.after(() => { apiClient.get = originalGet; });
  const controller = new AbortController();
  const packages = [{ id: "package-5", points: 5 }];
  apiClient.get = async (url, options) => {
    assert.equal(url, "/wallet/top-up-packages");
    assert.equal(options.signal, controller.signal);
    return { data: { data: packages } };
  };
  assert.deepEqual(await getTopUpPackages({ signal: controller.signal }), packages);
});

test("top-up package request failures are not silently converted to empty data", async (t) => {
  const originalGet = apiClient.get;
  t.after(() => { apiClient.get = originalGet; });
  apiClient.get = async () => { throw new Error("Network unavailable"); };
  await assert.rejects(getTopUpPackages(), /Network unavailable/);
});
