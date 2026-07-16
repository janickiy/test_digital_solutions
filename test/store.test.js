import assert from "node:assert/strict";
import test from "node:test";
import { ItemStore, PAGE_SIZE, ValidationError } from "../src/store.js";

function operation(opId, type, details) {
  return { opId, type, ...details };
}

test("available pagination never returns more than 20 items", () => {
  const store = new ItemStore({ baseItemCount: 100 });
  const firstPage = store.getAvailablePage({ limit: 999 });

  assert.equal(firstPage.items.length, PAGE_SIZE);
  assert.deepEqual(
    firstPage.items.map(({ id }) => id),
    Array.from({ length: 20 }, (_, index) => String(index + 1)),
  );
  assert.equal(firstPage.nextCursor, "20");
  assert.equal(firstPage.hasMore, true);

  const secondPage = store.getAvailablePage({ cursor: firstPage.nextCursor });
  assert.equal(secondPage.items[0].id, "21");
});

test("selected values disappear from the left list and keep their order", () => {
  const store = new ItemStore({ baseItemCount: 100 });
  store.applyOperations([
    operation("select-7", "select", { id: "7" }),
    operation("select-2", "select", { id: "2" }),
  ]);

  const availableIds = store.getAvailablePage().items.map(({ id }) => id);
  const selectedIds = store.getSelectedPage().items.map(({ id }) => id);

  assert.equal(availableIds.includes("2"), false);
  assert.equal(availableIds.includes("7"), false);
  assert.deepEqual(selectedIds, ["7", "2"]);
});

test("custom IDs are arbitrary and deduplicated against base and custom values", () => {
  const store = new ItemStore({ baseItemCount: 100 });
  const result = store.addItems(
    ["custom-42", "custom-42", "1", "001", "Пример"],
    "add-request-1",
  );

  assert.deepEqual(result.added, ["custom-42", "001", "Пример"]);
  assert.deepEqual(result.duplicates, ["1"]);
  assert.equal(store.getStats().custom, 3);

  const retry = store.addItems(["custom-42"], "add-request-1");
  assert.equal(retry.duplicateRequest, true);
  assert.equal(store.getStats().custom, 3);
});

test("reordering a filtered projection preserves hidden element slots", () => {
  const store = new ItemStore({ baseItemCount: 10 });
  store.addItems(["match-a", "hidden", "match-b", "match-c"], "seed-custom");
  store.applyOperations([
    operation("select-a", "select", { id: "match-a" }),
    operation("select-hidden", "select", { id: "hidden" }),
    operation("select-b", "select", { id: "match-b" }),
    operation("select-c", "select", { id: "match-c" }),
  ]);

  store.applyOperations([
    operation("reorder-filtered", "reorder", {
      orderedIds: ["match-c", "match-a", "match-b"],
      query: "match",
    }),
  ]);

  assert.deepEqual(store.selectedOrder, ["match-c", "hidden", "match-a", "match-b"]);
  assert.deepEqual(
    store.getSelectedPage({ query: "match" }).items.map(({ id }) => id),
    ["match-c", "match-a", "match-b"],
  );
});

test("operation IDs make retried mutations idempotent", () => {
  const store = new ItemStore({ baseItemCount: 10 });
  const first = store.applyOperations([
    operation("same-operation", "select", { id: "3" }),
  ]);
  const versionAfterFirstCall = store.version;
  const retry = store.applyOperations([
    operation("same-operation", "select", { id: "3" }),
  ]);

  assert.equal(first.results[0].changed, true);
  assert.equal(retry.results[0].duplicate, true);
  assert.equal(store.version, versionAfterFirstCall);
  assert.deepEqual(store.selectedOrder, ["3"]);
});

test("invalid reorder input is rejected without changing state", () => {
  const store = new ItemStore({ baseItemCount: 10 });
  store.applyOperations([
    operation("select-1", "select", { id: "1" }),
    operation("select-2", "select", { id: "2" }),
  ]);
  const before = [...store.selectedOrder];

  assert.throws(
    () =>
      store.applyOperations([
        operation("bad-reorder", "reorder", {
          orderedIds: ["1", "not-selected"],
          query: "",
        }),
      ]),
    ValidationError,
  );
  assert.deepEqual(store.selectedOrder, before);
});
