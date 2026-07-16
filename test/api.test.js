import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createApp } from "../src/server.js";
import { ItemStore } from "../src/store.js";

let server;
let baseUrl;

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  return { response, payload };
}

before(async () => {
  server = createApp({ store: new ItemStore({ baseItemCount: 100 }) }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test("batched read returns multiple deduplicatable resources", async () => {
  const { response, payload } = await post("/api/read/batch", {
    requests: [
      { key: "available:first", resource: "available", params: { limit: 100 } },
      { key: "stats", resource: "stats", params: {} },
    ],
  });

  assert.equal(response.status, 200);
  assert.equal(payload.results.length, 2);
  assert.equal(payload.results[0].data.items.length, 20);
  assert.equal(payload.results[1].data.total, 100);
});

test("add and state endpoints process idempotent batches", async () => {
  const firstAdd = await post("/api/items/batch", {
    requestId: "api-add-1",
    ids: ["external-id", "external-id", "1"],
  });
  assert.equal(firstAdd.response.status, 201);
  assert.deepEqual(firstAdd.payload.added, ["external-id"]);
  assert.deepEqual(firstAdd.payload.duplicates, ["1"]);

  const retryAdd = await post("/api/items/batch", {
    requestId: "api-add-1",
    ids: ["external-id"],
  });
  assert.equal(retryAdd.payload.duplicateRequest, true);

  const selection = await post("/api/state/batch", {
    operations: [
      { opId: "api-select-1", type: "select", id: "external-id" },
      { opId: "api-select-1", type: "select", id: "external-id" },
    ],
  });
  assert.equal(selection.response.status, 200);
  assert.equal(selection.payload.results[0].changed, true);
  assert.equal(selection.payload.results[1].duplicate, true);
  assert.equal(selection.payload.stats.selected, 1);
});

test("API rejects invalid state changes", async () => {
  const { response, payload } = await post("/api/state/batch", {
    operations: [{ opId: "missing-id", type: "select", id: "does-not-exist" }],
  });

  assert.equal(response.status, 400);
  assert.match(payload.error, /не существует/);
});
