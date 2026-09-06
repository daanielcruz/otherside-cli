import pkg from "../../package.json" with { type: "json" };

/**
 * What this build calls itself. One home: it is stamped onto session records,
 * shown in `/config`, sent with a design handshake and named in a heap dump, and
 * a second reader of the manifest is a second answer waiting to drift.
 */
export const OTHERSIDE_VERSION = pkg.version;
