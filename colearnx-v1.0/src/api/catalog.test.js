import assert from "node:assert/strict";
import test from "node:test";
import { deleteContentDraft, deleteCourseDraft } from "./catalog.js";
import { apiClient } from "./client.js";

test("draft delete clients call the matching protected API routes", async (context) => {
  const originalDelete = apiClient.delete;
  const requests = [];
  context.after(() => {
    apiClient.delete = originalDelete;
  });
  apiClient.delete = async (url) => {
    requests.push(url);
    return { data: { data: { url } } };
  };

  assert.deepEqual(await deleteCourseDraft("course-1"), { url: "/courses/course-1/draft" });
  assert.deepEqual(await deleteContentDraft("content-1"), { url: "/content/content-1/draft" });
  assert.deepEqual(requests, ["/courses/course-1/draft", "/content/content-1/draft"]);
});
