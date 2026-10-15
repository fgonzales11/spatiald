export function createStore(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    get: () => state,
    set(patch) {
      const previous = state;
      state = {
        ...state,
        ...(typeof patch === "function" ? patch(state) : patch),
      };
      for (const listener of listeners) listener(state, previous);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function readPreferences(storage = globalThis.localStorage) {
  try {
    const value = JSON.parse(
      storage?.getItem("tidebound.preferences.v1") || "{}",
    );
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
}
export function savePreferences(value, storage = globalThis.localStorage) {
  try {
    storage?.setItem("tidebound.preferences.v1", JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
