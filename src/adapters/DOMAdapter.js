class DOMNode {
  constructor(el) { this.el = el; }
  raw() { return this.el; }
  getTag() { return this.el.tagName.toLowerCase(); }
  getAttr(name) { return this.el.getAttribute(name); }
  getClasses() { return Array.from(this.el.classList); }
  getStyle(prop) {
    const inline = this.el.style.getPropertyValue(prop);
    if (inline) return inline;
    try {
      const view = this.el.ownerDocument.defaultView;
      const computed = view.getComputedStyle(this.el);
      return computed.getPropertyValue(prop) || null;
    } catch {
      return null;
    }
  }
  matches(selector) {
    try { return this.el.matches(selector); } catch { return false; }
  }
  getAncestors() {
    const out = [];
    let n = this.el.parentElement;
    while (n) { out.push(new DOMNode(n)); n = n.parentElement; }
    return out;
  }
  getTextPreview(maxLen = 60) {
    let text = (this.el.textContent || '').trim().replace(/\s+/g, ' ');
    if (text.length > maxLen) text = text.slice(0, maxLen - 1) + '…';
    return text;
  }
  remove() { this.el.remove(); }
  removeClass(name) { this.el.classList.remove(name); }
  removeStyleProperty(prop) { this.el.style.removeProperty(prop); }
  getSelectorPath() {
    const tag = this.getTag();
    const id = this.el.id ? `#${this.el.id}` : '';
    const cls = Array.from(this.el.classList).slice(0, 2).map(c => `.${c}`).join('');
    return `${tag}${id}${cls}`;
  }
}

class DOMRoot {
  constructor(root) {
    this.root = root;
  }
  queryAll(selector) {
    const out = [];
    // Include the root itself if it matches (only relevant when the root is an
    // Element, e.g. a subtree handed to the watch-mode MutationObserver).
    // Documents don't implement matches(), so the check is skipped for them.
    if (typeof this.root.matches === 'function' && this.root.matches(selector)) {
      out.push(new DOMNode(this.root));
    }
    if (typeof this.root.querySelectorAll === 'function') {
      for (const el of this.root.querySelectorAll(selector)) {
        out.push(new DOMNode(el));
      }
    }
    return out;
  }
  serialize() {
    if (this.root.documentElement) {
      return '<!DOCTYPE html>\n' + this.root.documentElement.outerHTML;
    }
    return this.root.outerHTML || '';
  }
  injectStyle(css, marker = 'modalmodules-unlock') {
    const doc = this.root.ownerDocument || this.root;
    if (!doc.head || typeof doc.createElement !== 'function') return false;
    if (doc.querySelector(`style[data-${marker}]`)) return false;
    const style = doc.createElement('style');
    style.setAttribute(`data-${marker}`, '');
    style.textContent = css;
    doc.head.appendChild(style);
    return true;
  }
}

export function createDOMAdapter(root) {
  return new DOMRoot(root);
}
