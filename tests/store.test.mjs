import test from "node:test";
import assert from "node:assert/strict";
import { createStore, readPreferences, savePreferences } from "../src/store.js";

test("observable state preserves subscribers until they unsubscribe", () => {
  const store = createStore({ selectedId: null });
  const records = [];
  const stop = store.subscribe((state, previous) =>
    records.push([state.selectedId, previous.selectedId]),
  );
  store.set({ selectedId: "meter" });
  stop();
  store.set({ selectedId: "transformer" });
  assert.deepEqual(records, [["meter", null]]);
});

test("corrupt or unavailable browser preferences recover to defaults", () => {
  for (const value of ["null", "[]", "0", "not JSON"])
    assert.deepEqual(readPreferences({ getItem: () => value }), {});
  assert.deepEqual(
    readPreferences({
      getItem() {
        throw new Error("Unavailable");
      },
    }),
    {},
  );
  assert.equal(
    savePreferences(
      { theme: "dark" },
      {
        setItem() {
          throw new Error("Quota");
        },
      },
    ),
    false,
  );
});
