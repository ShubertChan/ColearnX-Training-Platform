// Keep duplicate suppression synchronous; React state alone updates too late to
// guard a second click. Every notification is a snapshot, never the live Set.
export function createKeyedRequestGuard(onPendingChange) {
  const pending = new Set();
  return {
    async run(key, task) {
      if (pending.has(key)) return undefined;
      pending.add(key);
      onPendingChange(new Set(pending));
      try {
        return await task();
      } finally {
        pending.delete(key);
        onPendingChange(new Set(pending));
      }
    },
  };
}
