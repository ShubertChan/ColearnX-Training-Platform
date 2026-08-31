import test from "node:test";
import assert from "node:assert/strict";
import { apiClient } from "./client.js";
import { getAdminRoleApplications } from "./governance.js";

test("loads every page for a server-filtered administrator role queue", async () => {
  const originalGet = apiClient.get;
  const urls = [];
  const pages = [
    [{ id: "application-1" }, { id: "application-2" }],
    [{ id: "application-3" }],
  ];
  apiClient.get = async (url) => {
    urls.push(url);
    return { data: { data: pages[urls.length - 1] } };
  };

  try {
    const result = await getAdminRoleApplications({ status: "pending", limit: 2 });
    assert.deepEqual(result.map((item) => item.id), ["application-1", "application-2", "application-3"]);
    assert.deepEqual(urls, [
      "/admin/role-applications?limit=2&page=1&status=pending",
      "/admin/role-applications?limit=2&page=2&status=pending",
    ]);
  } finally {
    apiClient.get = originalGet;
  }
});

test("stops safely when an older API repeats the first page", async () => {
  const originalGet = apiClient.get;
  let calls = 0;
  apiClient.get = async () => {
    calls += 1;
    return { data: { data: [{ id: "application-1" }, { id: "application-2" }] } };
  };

  try {
    const result = await getAdminRoleApplications({ limit: 2 });
    assert.deepEqual(result.map((item) => item.id), ["application-1", "application-2"]);
    assert.equal(calls, 2);
  } finally {
    apiClient.get = originalGet;
  }
});
