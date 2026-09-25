import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ChatApp } from '../../chat/app.js';
import ChatInput from '../../chat/components/ChatInput.js';
import { setupRadioGroupKeyboard } from '../../chat/ui/radioGroupKeyboard.js';

function radios() {
    let handler;
    const clicks=[];
    const buttons=[0,1,2].map(i=>({disabled:false,getAttribute:()=>null,closest(){return this;},focus(){this.focused=true;},click(){clicks.push(i);}}));
    const group={getAttribute:()=>null,querySelectorAll:()=>buttons,addEventListener(_,fn){handler=fn;}};
    setupRadioGroupKeyboard(group);
    const press=(i,key,extra={})=>{const event={target:buttons[i],key,preventDefault(){this.prevented=true;},stopPropagation(){},...extra};handler(event);return event;};
    return {buttons,group,clicks,press};
}
test('radio arrows wrap and Home/End use the existing click handlers',()=>{
    const f=radios();
    assert.equal(f.press(0,'ArrowLeft').prevented,true);
    assert.equal(f.buttons[2].focused,true);
    f.press(2,'ArrowRight');f.press(0,'End');f.press(2,'Home');
    assert.deepEqual(f.clicks,[2,0,2,0]);
});
test('radio keys skip disabled choices and ignore shortcuts and disabled groups',()=>{
    const f=radios();f.buttons[1].disabled=true;f.press(0,'ArrowDown');
    assert.deepEqual(f.clicks,[2]);
    assert.equal(f.press(2,'ArrowLeft',{ctrlKey:true}).prevented,undefined);
    assert.equal(f.press(2,'Tab').prevented,undefined);
    f.group.getAttribute=()=> 'true';
    assert.equal(f.press(2,'Home').prevented,undefined);
    assert.deepEqual(f.clicks,[2]);
});
test('selected settings have radio semantics; model dialog and close control have names',()=>{
    // The full suite bundles tests into /tmp; source paths resolve from the repo root.
    const html=fs.readFileSync('chat/index.html','utf8');
    const segments=[...html.matchAll(/<button\b[^>]*class="[^"]*settings-segment[^"]*"[^>]*>/g)];
    assert.equal(segments.length,11);
    for(const [tag] of segments)assert.match(tag,/role="radio"/);
    assert.match(html,/role="dialog"[^>]*aria-label="Choose a model"/);
    assert.match(html,/<button[^>]*aria-label="Close model picker"[^>]*id="close-modal-btn"/);
});
test('theme changes leave only the selected radio in the tab order',()=>{
    const buttons=['system','light','dark'].map(theme=>({dataset:{themeOption:theme},setAttribute(name,value){this[name]=value;}}));
    ChatInput.prototype.updateThemeControls.call({app:{elements:{themeOptionButtons:buttons}}},'dark','dark');
    assert.deepEqual(buttons.map(b=>b.tabIndex),[-1,-1,0]);
    assert.deepEqual(buttons.map(b=>b['aria-checked']),['false','false','true']);
});
for(const closeEarly of [false,true])test(`history deletion focuses Cancel unless already closed: ${closeEarly}`,t=>{
    const oldDoc=globalThis.document,oldFrame=globalThis.requestAnimationFrame;
    t.after(()=>{globalThis.document=oldDoc;globalThis.requestAnimationFrame=oldFrame;});
    const classes=new Set(['hidden']);
    const modal={classList:{remove:c=>classes.delete(c),contains:c=>classes.has(c)},removeAttribute(){}};
    const calls=[];let frame;
    globalThis.document={activeElement:{}};
    globalThis.requestAnimationFrame=fn=>{frame=fn;};
    ChatApp.prototype.openDeleteHistoryModal.call({elements:{deleteHistoryModal:modal,deleteHistoryCancelBtn:{focus:()=>calls.push('cancel')},deleteHistoryConfirmBtn:{focus:()=>calls.push('delete')}}});
    if(closeEarly)classes.add('hidden');
    frame();assert.deepEqual(calls,closeEarly?[]:['cancel']);
});
