// Adapter contract. Both CheerioAdapter (server-side HTML) and DOMAdapter (live
// browser DOM) implement this shape. Detectors and the engine talk to this
// interface only — they never see cheerio or `window.document` directly.
//
// @typedef {Object} NodeAdapter
// @property {() => unknown} raw                    - underlying ref, for identity comparison
// @property {() => string} getTag                  - 'div', 'dialog', ...
// @property {(name: string) => string|null} getAttr
// @property {() => string[]} getClasses
// @property {(prop: string) => string|null} getStyle - inline; computed if available
// @property {(selector: string) => boolean} matches
// @property {() => NodeAdapter[]} getAncestors
// @property {(maxLen?: number) => string} getTextPreview - trimmed, single-spaced text content, truncated
// @property {() => void} remove
// @property {(name: string) => void} removeClass
// @property {(prop: string) => void} removeStyleProperty
// @property {() => string} getSelectorPath        - best-effort CSS path for reporting
//
// @typedef {Object} RootAdapter
// @property {(selector: string) => NodeAdapter[]} queryAll
// @property {() => string} serialize
