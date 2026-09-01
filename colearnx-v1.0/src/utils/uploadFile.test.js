import test from "node:test";
import assert from "node:assert/strict";
import { uploadFileToPresignedUrl } from "./uploadFile.js";

class FakeXhr {
  constructor() {
    this.headers = {};
    this.upload = {};
    this.status = 200;
  }
  open(method, url) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name, value) {
    this.headers[name] = value;
  }
  send(file) {
    this.file = file;
    this.upload.onprogress?.({ lengthComputable: true, loaded: file.size, total: file.size });
    queueMicrotask(() => this.onload());
  }
  abort() {
    this.onabort?.();
  }
}

test("R2 PUT uses only the exact required headers and sends raw file bytes", async () => {
  const xhr = new FakeXhr();
  const file = { name: "guide.pdf", size: 42 };
  const progress = [];
  const transfer = uploadFileToPresignedUrl({
    uploadUrl: "https://temporary-upload.example",
    file,
    requiredHeaders: { "Content-Type": "application/pdf" },
    onProgress: (event) => progress.push(event.loaded),
    xhrFactory: () => xhr,
  });
  await transfer.promise;
  assert.equal(xhr.method, "PUT");
  assert.equal(xhr.file, file);
  assert.deepEqual(xhr.headers, { "Content-Type": "application/pdf" });
  assert.equal(xhr.headers.Authorization, undefined);
  assert.equal(xhr.headers["X-CSRF-Token"], undefined);
  assert.equal(xhr.headers.Cookie, undefined);
  assert.deepEqual(progress, [42]);
});
