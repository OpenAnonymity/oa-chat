import test from 'node:test';
import assert from 'node:assert/strict';
import { isKeyboardViewport, setupResponsiveComposer } from '../../chat/ui/responsiveComposer.js';

test('keyboard detection excludes desktop resizing, browser chrome and pinch zoom', () => {
    const phone = {width:390, layoutHeight:844, height:480, editing:true};
    assert.equal(isKeyboardViewport(phone), true);
    for (const change of [{width:820}, {editing:false}, {height:780}, {scale:2}]) {
        assert.equal(isKeyboardViewport({...phone, ...change}), false);
    }
});

test('resizing moves the original controls without losing selection or the draft; cleanup detaches observers', () => {
    const observers = [];
    class Observer {
        constructor(callback) { this.callback = callback; observers.push(this); }
        observe() {}
        disconnect() { this.disconnected = true; }
    }
    const oldResize = globalThis.ResizeObserver;
    const oldMutation = globalThis.MutationObserver;
    globalThis.ResizeObserver = globalThis.MutationObserver = Observer;
    try {
        const elements = new Map();
        function element(id) {
            const el = new EventTarget();
            Object.assign(el, {id, dataset:{}, children:[], attrs:{}, style:{setProperty(){}},
                classList:{contains:()=>true}, width:680,
                getBoundingClientRect() {return {width:this.width};},
                setAttribute(k,v) {this.attrs[k]=v;},
                toggleAttribute(k,v) {this.attrs[k]=v;},
                append(...nodes) { for(const node of nodes) {node.parent=this; this.children.push(node);} },
                before(...nodes) {this.parent.append(...nodes);}
            });
            elements.set(id,el); return el;
        }
        for (const id of ['input-card','settings-menu','settings-btn','compact-composer-actions',
            'memory-context-toggle','chat-mode-toggle','send-btn','compact-scrub-btn',
            'compact-memory-slot','compact-mode-slot']) element(id);
        const row = element('row');
        const send = elements.get('send-btn'); send.parent=row;
        const root = element('root');
        const view = Object.assign(new EventTarget(), {innerWidth:1440, innerHeight:900,
            visualViewport:Object.assign(new EventTarget(), {height:900, offsetTop:0, scale:1})});
        const doc = Object.assign(new EventTarget(), {defaultView:view,documentElement:root,
            getElementById:id=>elements.get(id)});
        const input = {ownerDocument:doc,value:'Keep this draft'};
        doc.activeElement=input;
        const mode = elements.get('chat-mode-toggle'); mode.dataset.mode='parallel';
        const memory = elements.get('memory-context-toggle'); memory.attrs['aria-checked']='true';
        let scrubCount=0;
        const cleanup = setupResponsiveComposer({input,onScrub:()=>scrubCount++});
        const resize = observers[1];
        elements.get('input-card').width=358; resize.callback();
        assert.equal(mode.parent, elements.get('compact-mode-slot'));
        assert.equal(memory.parent, elements.get('compact-memory-slot'));
        assert.equal(elements.get('settings-btn').attrs['aria-label'], 'More options');
        assert.equal(elements.get('compact-composer-actions').hidden, false);
        elements.get('compact-scrub-btn').dispatchEvent(new Event('click'));
        assert.equal(scrubCount,1);
        elements.get('input-card').width=680; resize.callback();
        assert.equal(mode.parent,row); assert.equal(memory.parent,row);
        assert.equal(mode.dataset.mode,'parallel');
        assert.equal(memory.attrs['aria-checked'],'true');
        assert.equal(input.value,'Keep this draft');
        assert.equal(elements.get('compact-composer-actions').hidden,true);
        view.innerWidth=390; view.visualViewport.height=480;
        view.visualViewport.dispatchEvent(new Event('resize'));
        assert.equal(root.attrs['data-composer-keyboard'],true);
        cleanup();
        assert.ok(observers.every(o=>o.disconnected));
        elements.get('compact-scrub-btn').dispatchEvent(new Event('click'));
        assert.equal(scrubCount,1);
    } finally {
        globalThis.ResizeObserver=oldResize; globalThis.MutationObserver=oldMutation;
    }
});

test('sidebar presentation can shrink without overwriting its preferred desktop width', async () => {
    const {default:Sidebar} = await import('../../chat/components/Sidebar.js');
    const oldWindow=globalThis.window, oldDocument=globalThis.document;
    globalThis.window={innerWidth:1440};
    globalThis.document={documentElement:{style:{setProperty(){}}}};
    try {
        const sidebar = Object.create(Sidebar.prototype);
        sidebar.app={elements:{sidebar:{style:{}}}};
        sidebar.applySidebarWidth(400,{persist:false});
        globalThis.window.innerWidth=1100;
        sidebar.applySidebarWidth(sidebar.preferredSidebarWidth,{persist:false,layoutOnly:true});
        assert.equal(sidebar.app.elements.sidebar.style.width,'252px');
        assert.equal(sidebar.preferredSidebarWidth,400);
        globalThis.window.innerWidth=1440;
        sidebar.applySidebarWidth(sidebar.preferredSidebarWidth,{persist:false,layoutOnly:true});
        assert.equal(sidebar.app.elements.sidebar.style.width,'400px');
    } finally {globalThis.window=oldWindow; globalThis.document=oldDocument;}
});
