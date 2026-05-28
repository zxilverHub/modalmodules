import * as cheerio from 'cheerio';

class CheerioNode {
  constructor($, el) {
    this.$ = $;
    this.el = el;
  }
  raw() { return this.el; }
  getTag() { return this.el.tagName || this.el.name || ''; }
  getAttr(name) {
    const v = this.$(this.el).attr(name);
    return v == null ? null : v;
  }
  getClasses() {
    const cls = this.getAttr('class');
    if (!cls) return [];
    return cls.trim().split(/\s+/).filter(Boolean);
  }
  getStyle(prop) {
    const style = this.getAttr('style');
    if (!style) return null;
    const want = prop.toLowerCase();
    for (const decl of style.split(';')) {
      const idx = decl.indexOf(':');
      if (idx < 0) continue;
      const k = decl.slice(0, idx).trim().toLowerCase();
      if (k === want) return decl.slice(idx + 1).trim();
    }
    return null;
  }
  matches(selector) {
    try { return this.$(this.el).is(selector); } catch { return false; }
  }
  getAncestors() {
    return this.$(this.el).parents().toArray().map(a => new CheerioNode(this.$, a));
  }
  getTextPreview(maxLen = 60) {
    let text = (this.$(this.el).text() || '').trim().replace(/\s+/g, ' ');
    if (text.length > maxLen) text = text.slice(0, maxLen - 1) + '…';
    return text;
  }
  remove() { this.$(this.el).remove(); }
  removeClass(name) { this.$(this.el).removeClass(name); }
  removeStyleProperty(prop) {
    const style = this.getAttr('style');
    if (!style) return;
    const want = prop.toLowerCase();
    const kept = [];
    for (const decl of style.split(';')) {
      const idx = decl.indexOf(':');
      if (idx < 0) {
        const t = decl.trim();
        if (t) kept.push(t);
        continue;
      }
      const k = decl.slice(0, idx).trim().toLowerCase();
      if (k !== want) kept.push(decl.trim());
    }
    const newStyle = kept.join('; ');
    if (newStyle) this.$(this.el).attr('style', newStyle);
    else this.$(this.el).removeAttr('style');
  }
  getSelectorPath() {
    const tag = this.getTag();
    const id = this.getAttr('id');
    const cls = this.getClasses().slice(0, 2).join('.');
    let sel = tag;
    if (id) sel += `#${id}`;
    if (cls) sel += `.${cls}`;
    return sel;
  }
}

class CheerioRoot {
  constructor(html) {
    this.$ = cheerio.load(html);
  }
  queryAll(selector) {
    return this.$(selector).toArray().map(el => new CheerioNode(this.$, el));
  }
  serialize() {
    return this.$.html();
  }
  injectStyle(css, marker = 'modalmodules-unlock') {
    let head = this.$('head');
    if (head.length === 0) {
      this.$('html').prepend('<head></head>');
      head = this.$('head');
    }
    if (head.find(`style[data-${marker}]`).length > 0) return false;
    head.append(`<style data-${marker}>${css}</style>`);
    return true;
  }
}

export function createCheerioAdapter(html) {
  return new CheerioRoot(html);
}
