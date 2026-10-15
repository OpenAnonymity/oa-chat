import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
const { build } = createRequire(path.join(process.cwd(), 'package.json'))('esbuild');
import { createTimingRecorder, timingCallbacks, timingTextVisible } from '../chat/services/stagingRequestTiming.js';
import { stagingTimingPlugin } from '../scripts/stagingTimingBuild.mjs';

const make = () => { let now = 0; const timing = createTimingRecorder({ start: 0, model: 'test/model', now: () => now, visible: () => true }); return { timing, tick: value => { now = value; } }; };
test('records distinct reasoning, answer and render milestones without callback data', async () => {
    const {timing,tick} = make();
    const callbacks = timingCallbacks(timing, async () => { tick(460); }, () => {}, () => {});
    tick(100); timing.begin('access_ms'); tick(200); timing.end('access_ms'); timing.setKey('new');
    tick(210); timing.begin('verification_ms'); tick(300); timing.end('verification_ms');
    timing.mark('provider_dispatch_ms'); tick(350); callbacks.onOpen();
    tick(400); callbacks.onReasoning('', {withheld:true, private:'secret'});
    tick(450); await callbacks.onChunk('private answer');
    tick(500); timing.outcome('complete');
    const result = timing.record('not_sent');
    assert.equal(result.first_answer_ms,450); assert.equal(result.first_visible_answer_ms,460);
    assert.equal(result.first_reasoning_ms,400); assert.equal(result.access_ms,100); assert.equal(result.verification_ms,90);
    assert.equal(result.elapsed_ms,500); assert.equal(result.outcome,'complete'); assert.doesNotMatch(JSON.stringify(result),/private|secret/);
});
test('image-only, empty text and hidden background do not claim visible answer', async () => {
    let now=20;
    const timing=createTimingRecorder({start:0,model:'test/model',now:()=>now,visible:()=>false});
    const callbacks=timingCallbacks(timing,()=>{},()=>{},()=>{});
    await callbacks.onChunk(null,{images:['private']}); await callbacks.onChunk(' ');
    now=40; await callbacks.onChunk('answer');
    const result=timing.record('not_sent'); assert.equal(result.first_answer_ms,40);assert.equal(result.first_visible_answer_ms,null);
});
test('acquisition, recovered failure and cancellation produce honest final outcome',()=>{
    const {timing,tick}=make();timing.acquiring();timing.setKey('new');timing.setKey('reused');
    timing.begin('access_ms');tick(50);timing.end('access_ms');timing.outcome('error');
    tick(100);timing.begin('access_ms');tick(150);timing.end('access_ms');timing.outcome('complete');
    const result=timing.record('cancelled');assert.equal(result.key,'new');assert.equal(result.outcome,'complete');assert.equal(result.access_ms,100);
    tick(200);timing.mark('first_answer_ms');assert.equal(timing.record('complete').first_answer_ms,null);
});
test('enabled roots isolate lanes and concurrent chats; teardown emits once',async()=>{
    const bundle=await build({entryPoints:['chat/services/stagingRequestTiming.js'],bundle:true,format:'esm',write:false,define:{__OA_STAGING_TIMING__:'true'}});
    const api=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
    const rows=[];api.setStagingTimingSink(row=>rows.push(row));
    const a=new AbortController(), b=new AbortController();api.startRequestTiming(a.signal);api.startRequestTiming(b.signal);
    const one=api.requestTiming(a.signal,'primary','test/one'), two=api.requestTiming(a.signal,'secondary','test/two');
    api.requestTiming(b.signal,'single','test/three');one.outcome('complete');two.outcome('error');
    api.finishRequestTiming(a.signal);api.finishRequestTiming(a.signal);b.abort();api.finishRequestTiming(b.signal);
    assert.deepEqual(rows.map(row=>[row.model,row.outcome]),[['test/one','complete'],['test/two','error'],['test/three','cancelled']]);
    assert.equal(api.requestTiming(a.signal),null);
});
test('ordinary build replaces the full recorder implementation with inert stubs',async()=>{
    const bundle=await build({stdin:{contents:"import {startRequestTiming,requestTiming} from './chat/services/stagingRequestTiming.js';window.check=()=>{startRequestTiming({});return requestTiming({})}",resolveDir:process.cwd()},bundle:true,format:'esm',write:false,plugins:[stagingTimingPlugin(false)]});
    assert.doesNotMatch(bundle.outputFiles[0].text,/first_answer_ms|performance\.now|records: new Map|elapsed_ms/);
});

test('fast completed lane keeps its own end time when another lane later stops', () => {
    let now = 0;
    const first = createTimingRecorder({start:0,model:'test/first',now:()=>now});
    const second = createTimingRecorder({start:0,model:'test/second',now:()=>now});
    now=100; first.outcome('complete'); now=500;
    assert.equal(first.record('cancelled').outcome,'complete');
    assert.equal(first.record('cancelled').elapsed_ms,100);
    assert.equal(second.record('cancelled').elapsed_ms,500);
    assert.equal(second.record('cancelled').outcome,'cancelled');
});
test('failure before access retains an explicit missing first response',()=>{
    const {timing,tick}=make();tick(100);const row=timing.record('error');
    assert.equal(row.outcome,'error');assert.equal(row.first_answer_ms,null);assert.equal(row.access_ms,null);
});


test('terminal failure is frozen before another lane is cancelled',()=>{
    const {timing,tick}=make();tick(120);timing.settle('error');tick(900);
    assert.equal(timing.record('cancelled').outcome,'error');
    assert.equal(timing.record('cancelled').elapsed_ms,120);
});
test('retry spans round once and cannot exceed elapsed time from rounding bias',()=>{
    const {timing,tick}=make();timing.begin('access_ms');tick(6);timing.end('access_ms');
    timing.begin('access_ms');tick(12);timing.end('access_ms');timing.settle('error');
    assert.equal(timing.record('error').access_ms,10);assert.equal(timing.record('error').elapsed_ms,10);
});
test('visibility acknowledgement rejects background, hidden and offscreen content',()=>{
    const originalDocument=globalThis.document, originalWindow=globalThis.window;
    const content={textContent:'answer',closest:()=>null,checkVisibility:()=>true,getBoundingClientRect:()=>({width:100,height:20,top:20,bottom:40,left:0,right:100})};
    const row={querySelector:()=>content};const app={isViewingSession:()=>true,chatArea:{getCouncilLaneBody:()=>row}};
    try {
        globalThis.document={visibilityState:'visible',querySelector:()=>row};globalThis.window={innerHeight:500,innerWidth:500};
        assert.equal(timingTextVisible(app,'s','m'),true);assert.equal(timingTextVisible(app,'s','m','lane'),true);
        document.visibilityState='hidden';assert.equal(timingTextVisible(app,'s','m'),false);document.visibilityState='visible';
        content.checkVisibility=()=>false;assert.equal(timingTextVisible(app,'s','m'),false);content.checkVisibility=()=>true;
        content.closest=()=>({});assert.equal(timingTextVisible(app,'s','m'),false);content.closest=()=>null;
        content.getBoundingClientRect=()=>({width:100,height:20,top:600,bottom:620,left:0,right:100});assert.equal(timingTextVisible(app,'s','m'),false);
    } finally {globalThis.document=originalDocument;globalThis.window=originalWindow;}
});
