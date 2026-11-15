import assert from 'node:assert/strict';
import test from 'node:test';
import { LegacyTicketTransfer } from '../../chat/application/legacyTicketTransfer.js';
import { TicketCodeRedeemer } from '../../chat/application/ticketCodeRedeemer.js';
test('partial recovery stays retryable and a fresh controller restores the remainder after reload', async () => {
const OLD='61'.repeat(32), KEY='22'.repeat(32), scope='account:a';
function token(n) { const bytes=Buffer.alloc(354); bytes[1]=2; bytes[2]=n; Buffer.from(OLD,'hex').copy(bytes,66); return { finalized_ticket:bytes.toString('base64url') }; }
let wallet=[token(1),token(2)], attempt=null, issued=0, sequence=0, codeCount=0, redeemCalls=0;
const codes=new Map();
const pendingStore={list:async s=>[...codes.values()].filter(r=>r.scope===s).map(r=>structuredClone(r)),put:async r=>codes.set(r.code,structuredClone(r)),delete:async r=>codes.delete(r.code)};
const locks={request:async (name,fn)=>fn()};
let failFirst = true;
const makeRedeemer = () => new TicketCodeRedeemer({ pendingStore, lockManager:locks, getAccountScope:async()=>'a',
 privacyPass:{checkAvailability:async()=>true,getPublicKeyId:async()=>KEY,createChallenge:async()=>'',createSingleTokenRequest:async()=>({blindedRequest:`blind-${sequence++}`,serializedState:{}}),finalizeToken:async signed=>signed},
 ticketStore:{addTickets:async ts=>{issued+=ts.length;}},fetchIssuer:async()=>({public_key:'fake',key_id:KEY}),
 submit:async body=>{redeemCalls++; if(failFirst && body.credential.startsWith('a')) throw new Error('Transient relay failure'); return {key_id:KEY,signed_responses:body.blinded_requests.map(([i])=>[i,'signature'])};}
});
const makeTransfer = () => { const redeemer = makeRedeemer(); return new LegacyTicketTransfer({lockManager:locks, fetchInfo:async()=>({enabled:true,account_binding:true,key_id:OLD,max_batch:1}),getAccountScope:async()=>'a',listTickets:()=>wallet,holdKeyIds:()=>{}, pendingStore,
 attemptStore:{get:async()=>attempt,put:async r=>{attempt=structuredClone(r)},clear:async()=>{attempt=null}},removeTickets:async ts=>{const ids=new Set(ts.map(t=>t.finalized_ticket));wallet=wallet.filter(t=>!ids.has(t.finalized_ticket));},
 submit:async ts=>({code:(codeCount++?'b':'a').repeat(20)+'0001',tickets:1,transferred:[0],already_transferred:[],invalid:[],recovered_codes:[]}),
 redeemPending:o=>redeemer.run(null,undefined,o)
}); };
const result=await makeTransfer().run();
assert.equal(result.redeemed, false);
assert.match(result.redeemError.message, /still being restored/);
assert.equal(codes.size, 1);
assert.equal(issued, 1);
assert.equal(wallet.length, 0);
assert.equal(attempt, null);
// A new page has none of the old run's counters or controller state. The
// durable pending record is sufficient, including repeated failed reloads.
const retry = await makeTransfer().run();
assert.equal(retry.redeemed, false);
assert.ok(retry.redeemError);
assert.equal(issued, 1);
assert.equal(codes.size, 1);
failFirst = false;
const restored = await makeTransfer().run();
assert.equal(restored.redeemed, true);
assert.equal(restored.redeemError, null);
assert.equal(issued, 2);
assert.equal(codes.size, 0);
await makeTransfer().run();
assert.equal(issued, 2, 'a further reload cannot issue the finished tickets twice');
});
