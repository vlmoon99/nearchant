// Browser stand-in for Node's `process`, which some wallet libraries read at import time.
export const process = globalThis.process ?? (globalThis.process = { env: { NODE_ENV: "production" }, browser: true, version: "", versions: {}, nextTick: (f, ...a) => queueMicrotask(() => f(...a)) });
