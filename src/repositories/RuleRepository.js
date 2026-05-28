// RuleRepository contract. Anything that exposes `getRules(): Promise<object>`
// works. Swap implementations to source rules from disk, a DB, an HTTP endpoint,
// per-tenant overrides, etc., without changing services or detectors.
//
// @typedef {Object} RuleRepository
// @property {() => Promise<object>} getRules
