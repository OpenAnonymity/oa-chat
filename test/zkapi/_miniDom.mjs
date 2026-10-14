// A small DOM for tests of the components that build markup and bind events
// (the exit kit and give-up dialogs, the exit choice). It is not a browser: it
// parses the HTML the components write, keeps a tree with attributes and
// properties, answers the selectors the components use, bubbles events and
// implements the few default actions the components rely on (a checkbox
// toggles, a radio unchecks its group, a submit button submits its form, a
// dialog opens and closes) and offers a `classList` over the class attribute. What it does not do is on purpose: no layout, no
// CSS, no focus rules beyond "the last element that asked is active".
//
// Everything the tests need to observe is recorded: `document.focusLog`,
// `dialog.showModalCalls`, `anchor.clickCalls`.

const VOID = new Set(['input', 'br', 'hr', 'img', 'meta', 'link']);
const BOOLEAN_ATTRIBUTES = new Set(['disabled', 'hidden', 'checked', 'open', 'novalidate', 'required', 'readonly']);

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#96;': '`', '&nbsp;': ' ' };
const decode = text => text.replace(/&(?:amp|lt|gt|quot|#39|#96|nbsp);/g, match => ENTITIES[match]);
const escapeText = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttribute = text => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const kebab = name => name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
const camel = name => name.replace(/-([a-z0-9])/g, (match, letter) => letter.toUpperCase());

class MiniText {
    constructor(text) {
        this.nodeType = 3;
        this.text = text;
        this.parentNode = null;
    }

    get textContent() { return this.text; }
}

class MiniEvent {
    constructor(type, init = {}) {
        this.type = type;
        this.bubbles = init.bubbles !== false;
        this.cancelable = init.cancelable !== false;
        this.key = init.key;
        this.target = null;
        this.currentTarget = null;
        this.defaultPrevented = false;
        this.propagationStopped = false;
    }

    preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
    stopPropagation() { this.propagationStopped = true; }
}

export class MiniElement {
    constructor(tag, ownerDocument) {
        this.nodeType = 1;
        this.tagName = tag.toLowerCase();
        this.ownerDocument = ownerDocument;
        this.parentNode = null;
        this.children = [];
        this.attributes = new Map();
        this.listeners = new Map();
        this.checkedState = false;
        this.valueState = '';
        this.openState = false;
        this.clickCalls = 0;
        this.showModalCalls = 0;
        const self = this;
        this.dataset = new Proxy({}, {
            get: (target, name) => (typeof name === 'string' ? self.getAttribute(`data-${kebab(name)}`) ?? undefined : undefined),
            set: (target, name, value) => { self.setAttribute(`data-${kebab(String(name))}`, String(value)); return true; },
            has: (target, name) => self.hasAttribute(`data-${kebab(String(name))}`),
            ownKeys: () => [...self.attributes.keys()].filter(key => key.startsWith('data-')).map(key => camel(key.slice(5))),
            getOwnPropertyDescriptor: (target, name) => (self.hasAttribute(`data-${kebab(String(name))}`)
                ? { enumerable: true, configurable: true, value: self.getAttribute(`data-${kebab(String(name))}`) } : undefined)
        });
    }

    // -- attributes and properties ------------------------------------------
    setAttribute(name, value) {
        const key = String(name).toLowerCase();
        const text = String(value);
        this.attributes.set(key, text);
        if (key === 'checked') this.checkedState = true;
        if (key === 'value') this.valueState = text;
        if (key === 'open') this.openState = true;
    }

    getAttribute(name) {
        const key = String(name).toLowerCase();
        return this.attributes.has(key) ? this.attributes.get(key) : null;
    }

    hasAttribute(name) { return this.attributes.has(String(name).toLowerCase()); }

    removeAttribute(name) {
        const key = String(name).toLowerCase();
        this.attributes.delete(key);
        if (key === 'checked') this.checkedState = false;
        if (key === 'open') this.openState = false;
    }

    get id() { return this.getAttribute('id') ?? ''; }
    set id(value) { this.setAttribute('id', value); }
    get className() { return this.getAttribute('class') ?? ''; }
    set className(value) { this.setAttribute('class', value); }

    // A live view of the `class` attribute: what is written through it is what
    // `className`, `getAttribute('class')` and the `.class` selector read.
    get classList() {
        const element = this;
        const read = () => element.className.split(/\s+/).filter(Boolean);
        const write = names => element.setAttribute('class', names.join(' '));
        return {
            contains: name => read().includes(String(name)),
            add(...names) {
                const current = read();
                for (const name of names.map(String)) if (!current.includes(name)) current.push(name);
                write(current);
            },
            remove(...names) {
                const gone = new Set(names.map(String));
                write(read().filter(name => !gone.has(name)));
            },
            toggle(name, force) {
                const token = String(name);
                const on = force === undefined ? !read().includes(token) : Boolean(force);
                if (on) this.add(token); else this.remove(token);
                return on;
            }
        };
    }
    get type() { return this.getAttribute('type') ?? (this.tagName === 'button' ? 'submit' : 'text'); }
    set type(value) { this.setAttribute('type', value); }
    get name() { return this.getAttribute('name') ?? ''; }
    get href() { return this.getAttribute('href') ?? ''; }
    set href(value) { this.setAttribute('href', value); }
    get download() { return this.getAttribute('download') ?? ''; }
    set download(value) { this.setAttribute('download', value); }
    get rel() { return this.getAttribute('rel') ?? ''; }
    set rel(value) { this.setAttribute('rel', value); }
    get title() { return this.getAttribute('title') ?? ''; }

    get hidden() { return this.hasAttribute('hidden'); }
    set hidden(value) { if (value) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
    get disabled() { return this.hasAttribute('disabled'); }
    set disabled(value) { if (value) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }

    get checked() { return this.checkedState; }
    set checked(value) {
        const next = Boolean(value);
        this.checkedState = next;
        if (next && this.tagName === 'input' && this.type === 'radio' && this.name) {
            for (const other of this.groupOf()) {
                if (other !== this) other.checkedState = false;
            }
        }
    }

    get value() { return this.valueState; }
    set value(value) { this.valueState = String(value); }

    get open() { return this.openState; }
    get isConnected() {
        let node = this;
        while (node.parentNode) node = node.parentNode;
        return node === this.ownerDocument.documentElement;
    }

    groupOf() {
        let root = this;
        while (root.parentNode) root = root.parentNode;
        return root.querySelectorAll(`input[name="${this.name}"]`).filter(input => input.type === 'radio');
    }

    // -- tree -----------------------------------------------------------------
    append(...nodes) {
        for (const node of nodes) {
            const child = typeof node === 'string' ? new MiniText(node) : node;
            if (child.parentNode) child.parentNode.removeChild(child);
            child.parentNode = this;
            this.children.push(child);
        }
    }

    appendChild(node) { this.append(node); return node; }

    removeChild(node) {
        const at = this.children.indexOf(node);
        if (at >= 0) this.children.splice(at, 1);
        node.parentNode = null;
        return node;
    }

    remove() { if (this.parentNode) this.parentNode.removeChild(this); }

    contains(node) {
        for (let current = node; current; current = current.parentNode) if (current === this) return true;
        return false;
    }

    get textContent() { return this.children.map(child => child.textContent).join(''); }
    set textContent(value) {
        this.children.forEach(child => { child.parentNode = null; });
        this.children = [];
        const text = String(value ?? '');
        if (text) this.append(new MiniText(text));
    }

    get innerHTML() { return this.children.map(serialize).join(''); }
    set innerHTML(html) {
        this.children.forEach(child => { child.parentNode = null; });
        this.children = [];
        parse(String(html ?? ''), this);
    }

    get outerHTML() { return serialize(this); }

    // -- selectors --------------------------------------------------------------
    matches(selector) {
        return splitList(selector).some(complex => matchesComplex(this, complex));
    }

    closest(selector) {
        for (let node = this; node && node.nodeType === 1; node = node.parentNode) {
            if (node.matches(selector)) return node;
        }
        return null;
    }

    querySelectorAll(selector) {
        const out = [];
        const lists = splitList(selector);
        const visit = node => {
            for (const child of node.children) {
                if (child.nodeType !== 1) continue;
                if (lists.some(complex => matchesComplex(child, complex))) out.push(child);
                visit(child);
            }
        };
        visit(this);
        return out;
    }

    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }

    // -- events -----------------------------------------------------------------
    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(listener);
    }

    removeEventListener(type, listener) {
        const list = this.listeners.get(type) || [];
        const at = list.indexOf(listener);
        if (at >= 0) list.splice(at, 1);
    }

    dispatchEvent(event) {
        if (!event.target) event.target = this;
        for (let node = this; node && !event.propagationStopped; node = node.parentNode) {
            event.currentTarget = node;
            for (const listener of [...(node.listeners?.get(event.type) || [])]) listener.call(node, event);
            if (!event.bubbles) break;
        }
        return !event.defaultPrevented;
    }

    click() {
        if (this.disabled) return;
        this.clickCalls += 1;
        const checkbox = this.tagName === 'input' && this.type === 'checkbox';
        const radio = this.tagName === 'input' && this.type === 'radio';
        if (checkbox) this.checkedState = !this.checkedState;
        if (radio) this.checked = true;
        const proceed = this.dispatchEvent(new MiniEvent('click'));
        if (!proceed) {
            if (checkbox) this.checkedState = !this.checkedState;
            return;
        }
        if (checkbox || radio) {
            this.dispatchEvent(new MiniEvent('input'));
            this.dispatchEvent(new MiniEvent('change'));
        }
        if (this.tagName === 'button' && this.type === 'submit') {
            const form = this.closest('form');
            if (form) form.dispatchEvent(new MiniEvent('submit'));
        }
    }

    focus() {
        if (this.disabled) return;
        this.ownerDocument.activeElement = this;
        this.ownerDocument.focusLog.push(this);
    }

    // -- dialog -----------------------------------------------------------------
    showModal() {
        if (this.tagName !== 'dialog') throw new Error('not a dialog');
        this.showModalCalls += 1;
        this.openState = true;
        this.setAttribute('open', '');
        this.modal = true;
    }

    close() {
        if (!this.openState) return;
        this.openState = false;
        this.removeAttribute('open');
        this.modal = false;
        this.dispatchEvent(new MiniEvent('close', { bubbles: false, cancelable: false }));
    }
}

// ---------------------------------------------------------------------------
// Serialization and parsing
// ---------------------------------------------------------------------------

function serialize(node) {
    if (node.nodeType === 3) return escapeText(node.text);
    const attributes = [...node.attributes].map(([name, value]) => (
        value === '' && BOOLEAN_ATTRIBUTES.has(name) ? ` ${name}` : ` ${name}="${escapeAttribute(value)}"`)).join('');
    if (VOID.has(node.tagName)) return `<${node.tagName}${attributes}>`;
    return `<${node.tagName}${attributes}>${node.children.map(serialize).join('')}</${node.tagName}>`;
}

function parse(html, parent) {
    const stack = [parent];
    const token = /<!--[\s\S]*?-->|<\/([A-Za-z][\w-]*)\s*>|<([A-Za-z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>|([^<]+)|</g;
    let match;
    while ((match = token.exec(html)) !== null) {
        const top = stack[stack.length - 1];
        if (match[1]) {
            const tag = match[1].toLowerCase();
            for (let at = stack.length - 1; at > 0; at -= 1) {
                if (stack[at].tagName === tag) { stack.length = at; break; }
            }
        } else if (match[2]) {
            const element = new MiniElement(match[2], parent.ownerDocument);
            const attributes = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
            let found;
            while ((found = attributes.exec(match[3] || '')) !== null) {
                const value = found[2] ?? found[3] ?? found[4] ?? '';
                element.setAttribute(found[1], decode(value));
            }
            top.append(element);
            if (!match[4] && !VOID.has(element.tagName)) stack.push(element);
        } else if (match[5] !== undefined) {
            top.append(new MiniText(decode(match[5])));
        } else if (match[0] === '<') {
            top.append(new MiniText('<'));
        }
    }
}

// ---------------------------------------------------------------------------
// Selectors: lists, descendant and child combinators, and compounds of a tag,
// #id, .class and [attr] / [attr="value"] / [attr^="value"].
// ---------------------------------------------------------------------------

function splitList(selector) {
    const out = [];
    let depth = 0;
    let quote = '';
    let current = '';
    for (const character of String(selector)) {
        if (quote) {
            if (character === quote) quote = '';
        } else if (character === '"' || character === "'") quote = character;
        else if (character === '[') depth += 1;
        else if (character === ']') depth -= 1;
        if (character === ',' && depth === 0 && !quote) {
            out.push(current.trim());
            current = '';
        } else current += character;
    }
    if (current.trim()) out.push(current.trim());
    return out;
}

function splitCompounds(complex) {
    // Each part's combinator is its relation to the part before it.
    const parts = [];
    let depth = 0;
    let quote = '';
    let current = '';
    let pending = ' ';
    const flush = () => {
        if (!current) return;
        parts.push({ combinator: parts.length ? pending : ' ', compound: current });
        current = '';
        pending = ' ';
    };
    for (const character of complex) {
        if (quote) {
            current += character;
            if (character === quote) quote = '';
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            current += character;
            continue;
        }
        if (character === '[') depth += 1;
        if (character === ']') depth -= 1;
        if (depth === 0 && /\s/.test(character)) {
            flush();
            continue;
        }
        if (depth === 0 && character === '>') {
            flush();
            pending = '>';
            continue;
        }
        current += character;
    }
    flush();
    return parts;
}

function matchesCompound(element, compound) {
    const tag = /^[A-Za-z][\w-]*/.exec(compound);
    if (tag && element.tagName !== tag[0].toLowerCase()) return false;
    const rest = tag ? compound.slice(tag[0].length) : compound;
    const part = /#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:(\^?=)(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g;
    let found;
    while ((found = part.exec(rest)) !== null) {
        if (found[1] !== undefined) {
            if (element.id !== found[1]) return false;
        } else if (found[2] !== undefined) {
            if (!element.className.split(/\s+/).includes(found[2])) return false;
        } else {
            const actual = element.getAttribute(found[3]);
            if (actual === null) return false;
            if (found[4]) {
                const expected = found[5] ?? found[6] ?? found[7] ?? '';
                if (found[4] === '=' && actual !== expected) return false;
                if (found[4] === '^=' && !actual.startsWith(expected)) return false;
            }
        }
    }
    return true;
}

function matchesComplex(element, complex) {
    const parts = splitCompounds(complex);
    if (!parts.length) return false;
    const last = parts.length - 1;
    const walk = (node, index) => {
        if (!matchesCompound(node, parts[index].compound)) return false;
        if (index === 0) return true;
        const { combinator } = parts[index];
        let parent = node.parentNode;
        if (combinator === '>') return Boolean(parent) && parent.nodeType === 1 && walk(parent, index - 1);
        while (parent && parent.nodeType === 1) {
            if (walk(parent, index - 1)) return true;
            parent = parent.parentNode;
        }
        return false;
    };
    return walk(element, last);
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export function createDocument() {
    const document = {
        focusLog: [],
        activeElement: null,
        listeners: new Map(),
        createElement(tag) { return new MiniElement(tag, document); },
        getElementById(id) { return document.documentElement.querySelector(`#${id}`); },
        addEventListener() {},
        removeEventListener() {}
    };
    document.documentElement = new MiniElement('html', document);
    document.body = new MiniElement('body', document);
    document.documentElement.append(document.body);
    document.activeElement = document.body;
    // `isConnected` walks to the document element.
    document.documentElement.parentNode = null;
    return document;
}

export function keyEvent(type, key) {
    return new MiniEvent(type, { key });
}

export { MiniEvent };
