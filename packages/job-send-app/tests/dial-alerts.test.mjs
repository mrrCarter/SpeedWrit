import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createOwnerAlerts, createDialCaller } from '../dist/service.mjs';
import { startPostgres } from '../../job-send/tests/executor-support/pg.mjs';
import { seedJob, makeExecutor, storeVersion, CUSTOM } from '../../job-send/tests/executor-support/fixtures.mjs';

const HOST='https://alerts.example.test';
let db;
before(async()=>{db=await startPostgres({poolSize:8});});
after(async()=>{await db?.stop();});

async function harness(t, overrides={}) {
  const seed=await seedJob(db.pool,{max_sends:10});
  const {executor}=makeExecutor(db.pool);
  let time=Date.now(); const calls=[];
  const dial={apiKey:'test-private-dial-key',fromNumber:'test-private-source',ownerId:seed.owner,phone:'+14155550123',live:true,...overrides};
  const opts={pool:db.pool,host:HOST,owners:{owner:async(req)=>req.headers['x-test-owner']?{id:req.headers['x-test-owner'],email:'private@example.test'}:null},dial,jev:{configured:false,model:'jev-1.13.0'},pollMs:3600000,now:()=>time,call:async(id)=>{calls.push(id);return 'accepted';}};
  const alerts=createOwnerAlerts(opts); await alerts.start();
  const server=createServer((req,res)=>void alerts.handle(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=async(path,body,headers={})=>{
    const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'x-test-owner':seed.owner,...(body===undefined?{}:{origin:HOST,'content-type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:r.status,body:await r.json()};
  };
  t.after(async()=>{await alerts.stop();await new Promise(resolve=>server.close(resolve));});
  return {seed,executor,alerts,opts,calls,request,advance:(ms)=>{time+=ms;},held:()=>storeVersion(executor,db.pool,seed,{call:CUSTOM,reasons:['custom_content']})};
}

test('metadata is authenticated, contains no credentials or numbers, and GET creates no preference',async t=>{
  const h=await harness(t);
  assert.equal((await h.request('/owner/integrations',undefined,{'x-test-owner':''})).status,401);
  const r=await h.request('/owner/integrations');
  assert.equal(r.body.dial.configured,true);assert.equal(r.body.dial.enabled,false);
  for(const secret of ['test-private-dial-key','test-private-source','+14155550123','private@example.test'])assert.equal(JSON.stringify(r).includes(secret),false);
  assert.equal((await db.pool.query('SELECT 1 FROM owner_alert_preferences WHERE owner_id=$1',[h.seed.owner])).rowCount,0);
});
test('preference writes require exact origin, bound owner and strict boolean schema',async t=>{
  const h=await harness(t);
  assert.equal((await h.request('/owner/alerts/preferences',{enabled:true},{origin:'https://other.example.test'})).status,403);
  assert.equal((await h.request('/owner/alerts/preferences',{enabled:true},{'x-test-owner':'own_other'})).status,404);
  assert.equal((await h.request('/owner/alerts/preferences',{enabled:true,phone:'+14155550000'})).status,400);
  assert.equal((await h.request('/owner/alerts/preferences',{enabled:'true'})).status,400);
  assert.equal((await h.request('/owner/alerts/preferences',{enabled:true})).body.enabled,true);
});
test('credentials never enable calls without explicit DIAL_LIVE',async t=>{
  const h=await harness(t,{live:false});
  assert.equal((await h.request('/owner/alerts/preferences',{enabled:true})).status,409);
  assert.equal((await h.request('/owner/alerts/test',{})).status,409);
  await h.alerts.tick();assert.equal(h.calls.length,0);
});
test('enabling skips old receipts and coalesces new committed custom holds once',async t=>{
  const h=await harness(t);await h.held();
  await h.request('/owner/alerts/preferences',{enabled:true});
  await h.alerts.tick();h.advance(9000);await h.alerts.tick();assert.equal(h.calls.length,0);
  await h.held();await h.held();await h.alerts.tick();
  assert.equal((await h.request('/owner/integrations')).body.dial.pending,2);
  h.advance(9000);await h.alerts.tick();await h.alerts.tick();assert.equal(h.calls.length,1);
  assert.equal((await h.request('/owner/integrations')).body.dial.last_result.status,'accepted');
});
test('Off cancels queued notices before placement and does not replay them on reenable',async t=>{
  const h=await harness(t);await h.request('/owner/alerts/preferences',{enabled:true});await h.held();await h.alerts.tick();
  await h.request('/owner/alerts/preferences',{enabled:false});h.advance(70000);await h.alerts.tick();
  await h.request('/owner/alerts/preferences',{enabled:true});await h.alerts.tick();h.advance(9000);await h.alerts.tick();
  assert.equal(h.calls.length,0);assert.equal((await h.request('/owner/integrations')).body.dial.pending,0);
});
test('STOP pauses queued notices and disables the preference',async t=>{
  const h=await harness(t);await h.request('/owner/alerts/preferences',{enabled:true});await h.held();await h.alerts.tick();
  await h.alerts.disableForStop(h.seed.owner);h.advance(70000);await h.alerts.tick();
  assert.equal(h.calls.length,0);assert.equal((await h.request('/owner/alerts/preferences')).body.enabled,false);
});
test('a committed executor STOP also cancels notices without the HTTP wrapper',async t=>{
  const h=await harness(t);await h.request('/owner/alerts/preferences',{enabled:true});await h.held();await h.alerts.tick();
  await h.executor.engageStop(h.seed.connection,h.seed.owner);h.advance(9000);await h.alerts.tick();
  assert.equal(h.calls.length,0);assert.equal((await h.request('/owner/alerts/preferences')).body.enabled,false);
});
test('uncommitted receipt rows never enqueue a notification',async t=>{
  const h=await harness(t);const v=await h.held();await h.request('/owner/alerts/preferences',{enabled:true});
  let written,release;
  const ready=new Promise(resolve=>{written=resolve;});const hold=new Promise(resolve=>{release=resolve;});
  const tx=h.executor.withTx(h.seed.owner,async tx=>{
    await h.executor.writeReceipt(tx,'PROPOSAL_CREATED',{job:h.seed.job,proposal:v.proposalId,version:v.version,version_sha256:v.sha256});
    written();await hold;
  });
  try {
    await ready;await h.alerts.tick();assert.equal((await h.request('/owner/integrations')).body.dial.pending,0);
  } finally {release();await tx;}
  await h.alerts.tick();assert.equal((await h.request('/owner/integrations')).body.dial.pending,1);
  h.advance(9000);await h.alerts.tick();assert.equal(h.calls.length,1);
});
test('UNKNOWN alerts come from committed outcomes and an owner witness cancels an unplaced notice',async t=>{
  const h=await harness(t);const {executor,stub}=makeExecutor(db.pool,{script:['unknown:network','unknown:network']});
  await h.request('/owner/alerts/preferences',{enabled:true});
  const first=await storeVersion(executor,db.pool,h.seed);await executor.dispatch_auto(first.versionId);await h.alerts.tick();
  assert.equal((await h.request('/owner/integrations')).body.dial.pending,1);
  const dispatch=(await db.pool.query('SELECT id FROM dispatches WHERE proposal_version_id=$1',[first.versionId])).rows[0];
  await executor.resolveUnknown(dispatch.id,'not_arrived',h.seed.owner);h.advance(9000);await h.alerts.tick();assert.equal(h.calls.length,0);
  const second=await storeVersion(executor,db.pool,h.seed);await executor.dispatch_auto(second.versionId);await h.alerts.tick();h.advance(9000);await h.alerts.tick();
  assert.equal(h.calls.length,1);assert.equal(stub.callCount,2);
  assert.equal((await db.pool.query('SELECT sends_reserved FROM jobs WHERE id=$1',[h.seed.job])).rows[0].sends_reserved,2,'notifications never release UNKNOWN reservations');
});
test('another owner receipts and test requests cannot produce this owner call',async t=>{
  const h=await harness(t);await h.request('/owner/alerts/preferences',{enabled:true});
  const other=await seedJob(db.pool);await storeVersion(h.executor,db.pool,other,{call:CUSTOM,reasons:['custom_content']});
  assert.equal((await h.request('/owner/alerts/test',{}, {'x-test-owner':other.owner})).status,404);
  await h.alerts.tick();h.advance(9000);await h.alerts.tick();assert.equal(h.calls.length,0);
  assert.equal((await h.request('/owner/integrations',undefined,{'x-test-owner':other.owner})).body.dial.configured,false);
});
test('a hold resolved before the debounce expires no longer calls',async t=>{
  const h=await harness(t);await h.request('/owner/alerts/preferences',{enabled:true});const v=await h.held();await h.alerts.tick();
  await h.executor.approve(v.proposalId,v.version,v.sha256,h.seed.owner);h.advance(9000);await h.alerts.tick();
  assert.equal(h.calls.length,0);
});
test('explicit tests require enabled preference and respect persisted cooldown',async t=>{
  const h=await harness(t);
  assert.equal((await h.request('/owner/alerts/test',{})).status,409);
  await h.request('/owner/alerts/preferences',{enabled:true});assert.equal((await h.request('/owner/alerts/test',{})).status,202);
  await h.alerts.tick();assert.equal(h.calls.length,1);
  await h.request('/owner/alerts/test',{});await h.alerts.tick();assert.equal(h.calls.length,1);
  h.advance(60001);await h.alerts.tick();assert.equal(h.calls.length,2);
});
test('ambiguous calls are terminal and never retried after a tick or restart',async t=>{
  const h=await harness(t);h.opts.call=async id=>{h.calls.push(id);throw Error('private provider failure');};
  await h.request('/owner/alerts/preferences',{enabled:true});await h.request('/owner/alerts/test',{});await h.alerts.tick();
  assert.equal(h.calls.length,1);assert.equal((await h.request('/owner/integrations')).body.dial.last_result.status,'unknown');
  await h.alerts.stop();const restarted=createOwnerAlerts(h.opts);await restarted.start();t.after(()=>restarted.stop());
  h.advance(70000);await restarted.tick();assert.equal(h.calls.length,1);
});
test('restart cancels stale queued work and makes interrupted attempts unknown',async t=>{
  const h=await harness(t);await h.request('/owner/alerts/preferences',{enabled:true});await h.held();await h.alerts.tick();
  await db.pool.query("UPDATE owner_alert_outbox SET status='attempted',attempt_id='interrupted' WHERE owner_id=$1",[h.seed.owner]);
  assert.equal((await h.request('/owner/integrations')).body.dial.status,'unknown','an unrecorded provider result must not look ready');
  await h.alerts.stop();const restarted=createOwnerAlerts(h.opts);await restarted.start();t.after(()=>restarted.stop());
  h.advance(70000);await restarted.tick();assert.equal(h.calls.length,0);
  assert.equal((await db.pool.query('SELECT status FROM owner_alert_outbox WHERE owner_id=$1',[h.seed.owner])).rows[0].status,'unknown');
});
test('Dial adapter uses a fixed endpoint, private header, generic script and one request',async()=>{
  const seen=[];const caller=createDialCaller({apiKey:'private-key',fromNumber:'private-source',ownerId:'own_test',phone:'+14155550123',live:true},async(url,init)=>{seen.push({url,init});return Response.json({call:{id:'call_test'}});});
  assert.equal(await caller('attempt-1',new AbortController().signal),'accepted');assert.equal(seen.length,1);
  assert.equal(seen[0].url,'https://api.getdial.ai/api/v1/calls');assert.equal(seen[0].init.redirect,'error');
  const body=JSON.parse(seen[0].init.body);assert.equal(body.maxCallDurationSeconds,60);
  assert.equal(body.outboundInstruction.includes('+14155550123'),false);assert.equal(body.outboundInstruction.includes('private-key'),false);
  assert.equal(seen[0].init.headers['Idempotency-Key'],'attempt-1');
});
test('provider errors and malformed successes disclose no raw error and do not retry',async()=>{
  for(const reply of [()=>Response.json({secret:'private-error'},{status:503}),()=>Response.json({call:{}}),()=>{throw Error('private-error');}]){
    let calls=0;const caller=createDialCaller({apiKey:'key',fromNumber:'source',ownerId:'own_test',phone:'+14155550123',live:true},async()=>{calls++;return reply();});
    assert.equal(await caller('attempt-1',new AbortController().signal),'unknown');assert.equal(calls,1);
  }
});
