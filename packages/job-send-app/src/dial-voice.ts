import {randomBytes,randomUUID} from "node:crypto";
import type {IncomingMessage,ServerResponse} from "node:http";
import type {Pool,PoolClient} from "pg";
import type {Executor} from "@writ/job-send";
import type {AppHandler,OwnerSessions} from "@writ/job-send/server";
import type {AppConfig} from "./config.js";
import {VOICE_DISCLOSURE,digest,createVoiceTransport,verifyDialEvent,voiceReadback,voiceInstruction,instructionToken,confirmedVoiceDecision,type VoiceDraft} from "./dial-voice-protocol.js";

type Options={pool:Pool;host:string;owners:Pick<OwnerSessions,"owner">;dial:AppConfig["dial"];voice:AppConfig["voice"];
  executor:Pick<Executor,"decideVoice">;transport:ReturnType<typeof createVoiceTransport>;pollMs?:number};
class Refusal extends Error{constructor(readonly code:string,readonly status=409){super(code);}}
function send(res:ServerResponse,status:number,value:unknown){res.writeHead(status,{"content-type":"application/json","cache-control":"no-store","x-content-type-options":"nosniff"});res.end(JSON.stringify(value));}
async function bytes(req:IncomingMessage,limit:number){let n=0;const chunks:Buffer[]=[];for await(const chunk of req){n+=(chunk as Buffer).length;if(n>limit)throw new Refusal("too_large",413);chunks.push(chunk as Buffer);}return Buffer.concat(chunks);}
async function input(req:IncomingMessage){if((req.headers["content-type"]??"").split(";")[0]?.trim()!=="application/json")throw new Refusal("json_only",415);try{const value=JSON.parse((await bytes(req,2048)).toString("utf8"));if(!value||typeof value!=="object"||Array.isArray(value))throw Error();return value as Record<string,unknown>;}catch{throw new Refusal("invalid",400);}}
const ACTIVE=`p.status='pending' AND p.current_version=v.version AND v.state='pending' AND cardinality(v.review_reasons)>0
  AND j.status='active' AND j.expires_at>clock_timestamp() AND c.status='active' AND c.dispatch_enabled`;
const VERSION_JOIN=`FROM proposal_versions v JOIN proposals p ON p.id=v.proposal_id JOIN jobs j ON j.id=p.job_id JOIN connections c ON c.id=j.connection_id`;

/** Separate from coalesced generic alerts. A persisted voice session can name exactly one immutable
 * proposal version. No inbound call, generic notice, UNKNOWN or test can create this authority. */
export function createVoiceApprovals(options:Options){
 const {pool,dial,voice}=options;
 const configured=Boolean(voice.live&&voice.webhookSecret&&dial.live&&dial.apiKey&&dial.ownerId&&dial.phone&&dial.fromNumber);
 const binding=digest(JSON.stringify({owner:dial.ownerId,phone:dial.phone,source:dial.fromNumber,disclosure:VOICE_DISCLOSURE}));
 let timer:ReturnType<typeof setInterval>|undefined,running:Promise<void>|null=null,closed=false,started=false,generation=0;
 let controller:AbortController|null=null;
 let controls:Promise<unknown>=Promise.resolve();
 function control<T>(action:()=>Promise<T>):Promise<T>{const next=controls.then(action);controls=next.catch(()=>undefined);return next;}
 async function tx<T>(work:(c:PoolClient)=>Promise<T>):Promise<T>{const c=await pool.connect();try{await c.query("BEGIN");const value=await work(c);await c.query("COMMIT");return value;}catch(e){await c.query("ROLLBACK").catch(()=>undefined);throw e;}finally{c.release();}}
 const maxSeq=async(c:PoolClient,owner:string)=>Number((await c.query("SELECT COALESCE(MAX(seq),0) AS seq FROM receipts WHERE owner_id=$1",[owner])).rows[0].seq);
 async function cancel(c:PoolClient,owner:string){await c.query("UPDATE owner_voice_sessions SET status='cancelled',finished_at=clock_timestamp() WHERE owner_id=$1 AND status IN ('queued','placing','awaiting_reply')",[owner]);}
 async function preference(owner:string){const eligible_owner=owner===dial.ownerId;const row=eligible_owner?(await pool.query("SELECT enabled,config_sha256 FROM owner_voice_preferences WHERE owner_id=$1",[owner])).rows[0]:null;
  return {configured:eligible_owner&&configured,eligible_owner,enabled:eligible_owner&&configured&&row?.enabled===true&&row.config_sha256===binding,disclosure_version:VOICE_DISCLOSURE};}
 async function setEnabled(owner:string,enabled:boolean){if(owner!==dial.ownerId)throw new Refusal("not_found",404);if(enabled&&!configured)throw new Refusal("not_configured");generation++;
  await control(()=>tx(async c=>{await c.query("INSERT INTO owner_voice_preferences(owner_id) VALUES($1) ON CONFLICT DO NOTHING",[owner]);await c.query("SELECT owner_id FROM owner_voice_preferences WHERE owner_id=$1 FOR UPDATE",[owner]);await cancel(c,owner);
   await c.query("UPDATE owner_voice_preferences SET enabled=$2,cursor_seq=$3,disclosure_version=$4,config_sha256=$5,updated_at=clock_timestamp() WHERE owner_id=$1",[owner,enabled,await maxSeq(c,owner),enabled?VOICE_DISCLOSURE:null,enabled?binding:null]);}));return preference(owner);}
 async function disableForStop(owner:string){if(owner!==dial.ownerId)return;generation++;await control(()=>tx(async c=>{await c.query("SELECT owner_id FROM owner_voice_preferences WHERE owner_id=$1 FOR UPDATE",[owner]);await c.query("UPDATE owner_voice_preferences SET enabled=false,updated_at=clock_timestamp() WHERE owner_id=$1",[owner]);await cancel(c,owner);}));}
 async function enqueue(c:PoolClient,owner:string,versionId:string,sha:string){await c.query(`INSERT INTO owner_voice_sessions(id,owner_id,proposal_version_id,version_sha256,config_sha256,expires_at)
  VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '5 minutes') ON CONFLICT(proposal_version_id) DO NOTHING`,["voice_"+randomUUID(),owner,versionId,sha,binding]);}
 async function requestCall(owner:string,body:Record<string,unknown>){
  if(owner!==dial.ownerId)throw new Refusal("not_found",404);
  if(Object.keys(body).sort().join(",")!=="disclosure_version,proposal_id,shown_sha256,version"||body.disclosure_version!==VOICE_DISCLOSURE
   ||typeof body.proposal_id!=="string"||!/^prp_[A-Za-z0-9_-]{1,96}$/.test(body.proposal_id)||!Number.isInteger(body.version)
   ||typeof body.shown_sha256!=="string"||!/^[a-f0-9]{64}$/.test(body.shown_sha256))throw new Refusal("invalid",400);
  return tx(async c=>{const pref=(await c.query("SELECT enabled,config_sha256 FROM owner_voice_preferences WHERE owner_id=$1 FOR UPDATE",[owner])).rows[0];if(!configured||!pref?.enabled||pref.config_sha256!==binding)throw new Refusal("voice_disabled");
   const row=(await c.query(`SELECT v.id,v.sha256 ${VERSION_JOIN} WHERE j.owner_id=$1 AND p.id=$2 AND v.version=$3 AND v.sha256=$4 AND ${ACTIVE}`,[owner,body.proposal_id,body.version,body.shown_sha256])).rows[0];
   if(!row)throw new Refusal("not_pending");await enqueue(c,owner,row.id,row.sha256);
   const s=(await c.query("SELECT id,status FROM owner_voice_sessions WHERE proposal_version_id=$1",[row.id])).rows[0];return {session_id:s.id,status:s.status};});
 }
 async function work(){
  if(closed||!configured||!dial.ownerId)return;const owner=dial.ownerId,epoch=generation;
  const selected=await tx(async c=>{
   const pref=(await c.query("SELECT * FROM owner_voice_preferences WHERE owner_id=$1 FOR UPDATE",[owner])).rows[0];if(!pref?.enabled||pref.config_sha256!==binding){await cancel(c,owner);return null;}
   // An unpaged STOP query prevents a large receipt page from letting an old queued call through.
   if((await c.query("SELECT 1 FROM receipts WHERE owner_id=$1 AND seq>$2 AND type='STOP_ENGAGED' LIMIT 1",[owner,pref.cursor_seq])).rowCount){await c.query("UPDATE owner_voice_preferences SET enabled=false WHERE owner_id=$1",[owner]);await cancel(c,owner);return null;}
   const receipts=(await c.query("SELECT seq,type,payload::jsonb->>'proposal' AS proposal,payload::jsonb->>'version' AS version FROM receipts WHERE owner_id=$1 AND seq>$2 ORDER BY seq LIMIT 500",[owner,pref.cursor_seq])).rows;
   for(const r of receipts){if(!["PROPOSAL_CREATED","PROPOSAL_REVISED"].includes(r.type)||!/^\d+$/.test(r.version??""))continue;
    const v=(await c.query(`SELECT v.id,v.sha256 ${VERSION_JOIN} WHERE j.owner_id=$1 AND p.id=$2 AND v.version=$3 AND ${ACTIVE}`,[owner,r.proposal,Number(r.version)])).rows[0];if(v)await enqueue(c,owner,v.id,v.sha256);}
   if(receipts.length)await c.query("UPDATE owner_voice_preferences SET cursor_seq=$2 WHERE owner_id=$1",[owner,receipts.at(-1).seq]);
   await c.query(`UPDATE owner_voice_sessions s SET status='cancelled',finished_at=clock_timestamp() WHERE s.owner_id=$1 AND s.status IN ('queued','awaiting_reply')
    AND (s.expires_at<=clock_timestamp() OR NOT EXISTS(SELECT 1 ${VERSION_JOIN} WHERE v.id=s.proposal_version_id AND v.sha256=s.version_sha256 AND ${ACTIVE}))`,[owner]);
   if(pref.last_attempt_at&&Date.now()-new Date(pref.last_attempt_at).getTime()<60000)return null;
   const s=(await c.query(`SELECT s.*,v.recipient,v.subject,v.body,v.version FROM owner_voice_sessions s JOIN proposal_versions v ON v.id=s.proposal_version_id
    WHERE s.owner_id=$1 AND s.status='queued' ORDER BY s.created_at LIMIT 1 FOR UPDATE OF s`,[owner])).rows[0];if(!s)return null;
   const token=randomBytes(32).toString("base64url");let instruction:string;
   try{instruction=voiceInstruction(s as VoiceDraft,token);}catch{
    // Definitively no provider request: retain a content-free notice even if its cursor passed.
    await c.query("UPDATE owner_voice_sessions SET status='failed',finished_at=clock_timestamp() WHERE id=$1",[s.id]);
    await c.query(`INSERT INTO owner_alert_outbox(id,owner_id,receipt_seq,kind,due_at)
     SELECT $1,r.owner_id,r.seq,'attention',clock_timestamp()+interval '8 seconds' FROM receipts r
     JOIN proposal_versions v ON v.id=$3 JOIN owner_alert_preferences ap ON ap.owner_id=r.owner_id
     WHERE r.owner_id=$2 AND r.type IN ('PROPOSAL_CREATED','PROPOSAL_REVISED')
      AND r.payload::jsonb->>'proposal'=v.proposal_id AND r.payload::jsonb->>'version'=v.version::text
      AND ap.enabled AND ap.updated_at<=$4 ORDER BY r.seq DESC LIMIT 1
     ON CONFLICT(owner_id,receipt_seq) DO NOTHING`,[randomUUID(),owner,s.proposal_version_id,s.created_at]);return null;}
   await c.query(`UPDATE owner_voice_sessions SET status='placing',token_sha256=$2,instruction_sha256=$3,phone_sha256=$4,
    expires_at=clock_timestamp()+interval '5 minutes' WHERE id=$1`,[s.id,digest(token),digest(instruction),digest(dial.phone!)]);
   await c.query("UPDATE owner_voice_preferences SET last_attempt_at=clock_timestamp() WHERE owner_id=$1",[owner]);
   return {id:s.id,instruction};
  });
  if(!selected)return;if(closed||epoch!==generation){await pool.query("UPDATE owner_voice_sessions SET status='cancelled',finished_at=clock_timestamp() WHERE id=$1 AND status='placing'",[selected.id]);return;}
  controller=new AbortController();
  try{const call=await options.transport.place({attemptId:selected.id,to:dial.phone!,fromNumber:dial.fromNumber!,instruction:selected.instruction},controller.signal);
   if(call.direction!=="outbound"||call.to!==dial.phone||!/^\+[1-9]\d{7,14}$/.test(call.from)||(dial.fromNumber!.startsWith("+")&&call.from!==dial.fromNumber))throw Error("call_binding_mismatch");
   await pool.query("UPDATE owner_voice_sessions SET status='awaiting_reply',call_id=$2,from_sha256=$3 WHERE id=$1 AND status='placing'",[selected.id,call.id,digest(call.from)]);
  }catch{await pool.query("UPDATE owner_voice_sessions SET status='unknown',finished_at=clock_timestamp() WHERE id=$1 AND status='placing'",[selected.id]);}
  finally{controller=null;}
 }
 async function tick(){if(running)return running;running=work().catch(()=>undefined).finally(()=>{running=null;});return running;}
 async function start(){if(started||closed)return;started=true;const owner=dial.ownerId;if(owner)await tx(async c=>{const p=(await c.query("SELECT enabled,config_sha256 FROM owner_voice_preferences WHERE owner_id=$1 FOR UPDATE",[owner])).rows[0];if(!p)return;
   await c.query("UPDATE owner_voice_preferences SET cursor_seq=$2,enabled=enabled AND COALESCE(config_sha256=$3,false) WHERE owner_id=$1",[owner,await maxSeq(c,owner),binding]);
   // No automatic replay after a restart, including an ambiguously placed phone call.
   await cancel(c,owner);
  });if(configured){timer=setInterval(()=>{void tick();},options.pollMs??2000);timer.unref();}}
 async function callback(req:IncomingMessage){
  if(!configured||!voice.webhookSecret||req.method!=="POST")throw new Refusal("not_found",404);
  const raw=await bytes(req,32768),event=verifyDialEvent(voice.webhookSecret,req.headers["x-dial-signature"],req.headers["x-dial-event-id"],req.headers["x-dial-event-type"],raw);
  if(!event)throw new Refusal("invalid_signature",401);
  const s=(await pool.query(`SELECT s.*,v.recipient,v.subject,v.body,v.version FROM owner_voice_sessions s JOIN proposal_versions v ON v.id=s.proposal_version_id
    WHERE s.call_id=$1 AND s.owner_id=$2`,[event.data.callId,dial.ownerId])).rows[0];
  if(!s||s.status!=="awaiting_reply"||s.consumed_at!==null)return {received:true};
  let valid=false;try{
   const call=await options.transport.get(s.call_id),token=instructionToken(call.instruction);
   const decision=confirmedVoiceDecision(call.transcriptTurns,voiceReadback(s));
   valid=call.id===s.call_id&&call.direction==="outbound"&&call.to===dial.phone&&digest(call.to)===s.phone_sha256&&digest(call.from)===s.from_sha256
    &&call.voiceRuntime==="managed"&&call.status?.state==="Terminated"&&call.status.terminationType==="completed"
    &&call.status.cancelRequested===false&&call.status.cancelPending===false&&!call.transferTo&&!call.transferredAt
    &&typeof call.instruction==="string"&&digest(call.instruction)===s.instruction_sha256&&token!==null&&digest(token)===s.token_sha256&&decision!==null;
   if(valid&&token&&decision){await options.executor.decideVoice(s.owner_id,{sessionId:s.id,callId:s.call_id,token,eventId:event.id,decision,configSha256:binding,transcriptSha256:digest(JSON.stringify(call.transcriptTurns))});return {received:true};}
  }catch{/* No raw provider error, transcript or credential reaches output. */}
  await pool.query("UPDATE owner_voice_sessions SET status='no_decision',consumed_at=clock_timestamp(),event_id=$2,finished_at=clock_timestamp() WHERE id=$1 AND status='awaiting_reply'",[s.id,event.id]);
  return {received:true};
 }
 const handle:AppHandler=async(req,res)=>{const url=new URL(req.url??"/",options.host),path=url.pathname;
  if(!["/owner/voice/preferences","/owner/voice/calls","/integrations/dial/voice/events"].includes(path))return false;
  try{
   if(path==="/integrations/dial/voice/events"){send(res,200,await callback(req));return true;}
   const owner=await options.owners.owner(req);if(!owner)throw new Refusal("sign_in",401);
   if(req.method==="GET"&&path.endsWith("preferences"))send(res,200,await preference(owner.id));
   else if(req.method==="GET"&&path.endsWith("calls")){
    if(owner.id!==dial.ownerId)throw new Refusal("not_found",404);
    const proposal=url.searchParams.get("proposal_id");if(!proposal||!/^prp_[A-Za-z0-9_-]{1,96}$/.test(proposal))throw new Refusal("invalid",400);
    const rows=(await pool.query(`SELECT s.id AS session_id,s.status,s.decision,v.version,s.version_sha256,s.expires_at FROM owner_voice_sessions s
     JOIN proposal_versions v ON v.id=s.proposal_version_id WHERE s.owner_id=$1 AND v.proposal_id=$2 ORDER BY v.version LIMIT 5`,[owner.id,proposal])).rows;send(res,200,{sessions:rows});
   }else if(req.method==="POST"){
    if(req.headers.origin!==options.host)throw new Refusal("origin",403);const body=await input(req);
    if(path.endsWith("preferences")){
     if(typeof body.enabled!=="boolean"||Object.keys(body).sort().join(",")!==(body.enabled?"disclosure_version,enabled":"enabled")||(body.enabled&&body.disclosure_version!==VOICE_DISCLOSURE))throw new Refusal("invalid",400);
     send(res,200,await setEnabled(owner.id,body.enabled));
    }else send(res,202,await requestCall(owner.id,body));
   }else throw new Refusal("method_not_allowed",405);
  }catch(e){send(res,e instanceof Refusal?e.status:500,{error:e instanceof Refusal?e.code:"voice_error"});}return true;
 };
 return {configured,binding,handle,start,tick,disableForStop,async stop(){closed=true;generation++;if(timer)clearInterval(timer);controller?.abort();await running;await controls;}};
}
