import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createWorker, OWNED_ORIGIN, UPSTREAM_ORIGIN} from './dist/worker.mjs';

const request = (path, init) => new Request(OWNED_ORIGIN + path, init);
const hash = (text) => createHash('sha256').update(text).digest('hex');
const pageHashes = {
  '/about':'d53961957b773a1a04cc795c9101191671350b00b541fc762b727c8fc3b43401',
  '/privacy':'37663ec62625bba5570aff41acc83d2b78d8d722a19c7f20c79f39245c3141e8',
  '/terms':'466fe3401e5c8c87af726db0c1f1510856f2a684c8288f7d46189b787476e0b7',
};
const noFetch = async () => { throw Error('unexpected_fetch'); };

test('exact reviewed public source and deployment account/domain remain fixed', () => {
  // Git may check this TypeScript file out with CRLF on Windows; its reviewed content is LF.
  const publicSource=readFileSync(new URL('../../packages/job-send-ui/src/serve/publicPages.ts', import.meta.url),'utf8').replace(/\r\n/g,'\n');
  assert.equal(hash(publicSource), 'd335922072c8e5e1ea69a1e3d5df1908b61e9d971188243c37cbca241af25b5b');
  assert.deepEqual(JSON.parse(readFileSync(new URL('./wrangler.jsonc', import.meta.url), 'utf8')), {
    name:'speedwrit-public', main:'worker.ts', compatibility_date:'2026-10-11',
    workers_dev:false, preview_urls:false,
    routes:[{pattern:'speedwrit.aidenid.com', custom_domain:true}],
    observability:{enabled:false}, account_id:'a2324d194def16dd3617d1f362c21893',
  });
});

for (const [path, expectedHash] of Object.entries(pageHashes)) {
  test(path + ' stays exact static HTML with no transform or proxy', async () => {
    const worker=createWorker(noFetch);
    const r=await worker.fetch(request(path+'?ignored=fixture'));
    assert.equal(r.status,200);assert.equal(hash(await r.text()),expectedHash);
    assert.equal(r.headers.get('cache-control'),'no-store, no-transform');
    assert.match(r.headers.get('content-security-policy'),/default-src 'none'/);
    assert.equal(r.headers.get('set-cookie'),null);
    assert.equal(await (await worker.fetch(request(path,{method:'HEAD'}))).text(),'');
    assert.equal((await worker.fetch(request(path,{method:'POST',body:'fixture'}))).status,405);
  });
}

test('root redirects to owned connections, dropping incoming query', async () => {
  const r=await createWorker(noFetch).fetch(request('/?return_to=https://unrelated.invalid'));
  assert.equal(r.status,302);assert.equal(r.headers.get('location'),'/owner-app/#/connect');
  assert.equal(await r.text(),'');
});

for (const path of ['/owner-app/','/owner-app/app.js','/owner-app/config.json','/.well-known/oauth-protected-resource/mcp','/.well-known/oauth-authorization-server','/auth/google/callback?code=fixture%2Bvalue&state=a%26b','/auth/gmail/callback?code=fixture','/mcp/c/'+ 'f'.repeat(43)]) {
  test(path.split('?')[0]+' forwards fixed origin and exact path/query',async()=>{
    let calls=0;
    const r=await createWorker(async(req,init)=>{
      calls++;assert.equal(req.url,UPSTREAM_ORIGIN+path);assert.equal(req.method,'GET');
      assert.equal(init.redirect,'manual');assert.equal(init.cache,'no-store');
      return new Response('exact-upstream-body',{status:200,headers:{'content-type':'application/octet-stream'}});
    }).fetch(request(path));
    assert.equal(calls,1);assert.equal(await r.text(),'exact-upstream-body');
    assert.equal(r.headers.get('cache-control'),'no-store, no-transform');
  });
}

for (const [path, contentType, body] of [
  ['/mcp','application/json','{"jsonrpc":"2.0","method":"tools/list","id":1}'],
  ['/oauth/token','application/x-www-form-urlencoded','grant_type=fixture&code=a%2Bb&resource=https%3A%2F%2Fspeedwrit.aidenid.com%2Fmcp'],
  ['/oauth/authorize','application/x-www-form-urlencoded','request_id=fixture&decision=allow'],
  ['/owner/alerts/preferences','application/json','{"enabled":false}'],
]) {
  test(path+' preserves method, body, Origin and necessary auth/MCP headers',async()=>{
    let calls=0;
    const headers={authorization:'Bearer fixture-only',cookie:'__Host-fixture=one',origin:OWNED_ORIGIN,referer:OWNED_ORIGIN+'/owner-app/',accept:'application/json, text/event-stream','content-type':contentType,'mcp-protocol-version':'2025-06-18'};
    const r=await createWorker(async(req,init)=>{
      calls++;assert.equal(req.method,'POST');assert.equal(await req.text(),body);
      for(const [name,value] of Object.entries(headers))assert.equal(req.headers.get(name),value);
      assert.equal(init.redirect,'manual');return new Response('{}',{headers:{'content-type':'application/json'}});
    }).fetch(request(path,{method:'POST',headers,body}));
    assert.equal(calls,1);assert.equal(r.status,200);
  });
}

test('multiple __Host cookies and strict auth/CSP headers survive unchanged',async()=>{
  const headers=new Headers({
    'content-security-policy':"default-src 'none'; form-action 'self' https://client.example",
    'referrer-policy':'same-origin','www-authenticate':'Bearer resource_metadata="https://speedwrit.aidenid.com/.well-known/oauth-protected-resource"',
    'access-control-allow-origin':'*','access-control-expose-headers':'www-authenticate','vary':'Origin',
  });
  const cookies=['__Host-session=fixture; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600','__Host-binding=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'];
  for(const cookie of cookies)headers.append('set-cookie',cookie);
  const r=await createWorker(async()=>new Response('fixture',{status:401,headers})).fetch(request('/auth/google/callback'));
  assert.deepEqual(r.headers.getSetCookie(),cookies);
  for(const name of ['content-security-policy','referrer-policy','www-authenticate','access-control-allow-origin','access-control-expose-headers','vary'])assert.equal(r.headers.get(name),headers.get(name));
  assert.equal(r.status,401);assert.equal(await r.text(),'fixture');
});

test('external redirect is returned intact after one request carrying credentials',async()=>{
  let calls=0;
  const location='https://accounts.google.com/o/oauth2/v2/auth?state=fixture';
  const r=await createWorker(async(req,init)=>{
    calls++;assert.equal(new URL(req.url).origin,UPSTREAM_ORIGIN);
    assert.equal(req.headers.get('authorization'),'Bearer fixture-only');
    assert.equal(req.headers.get('cookie'),'__Host-fixture=one');assert.equal(init.redirect,'manual');
    return new Response('redirect-body',{status:302,headers:{location,'referrer-policy':'no-referrer'}});
  }).fetch(request('/auth/sign-in',{headers:{authorization:'Bearer fixture-only',cookie:'__Host-fixture=one'}}));
  assert.equal(calls,1);assert.equal(r.status,302);assert.equal(r.headers.get('location'),location);assert.equal(await r.text(),'redirect-body');
});

test('authority-shaped paths and hostile Host forwarding headers cannot change destination',async()=>{
  for(const path of ['//unrelated.invalid/path?url=https://other.invalid','/mcp?upstream=https://other.invalid','/%2F%2Fother.invalid/path']){
    let calls=0;
    const r=await createWorker(async(req)=>{
      calls++;assert.equal(new URL(req.url).origin,UPSTREAM_ORIGIN);assert.equal(req.headers.get('host'),null);
      return new Response('fixture');
    }).fetch(request(path,{headers:{host:'other.invalid','x-forwarded-host':'other.invalid','x-forwarded-proto':'http','x-original-url':'https://other.invalid'}}));
    const allowed=path.startsWith('/mcp?');
    assert.equal(calls,allowed?1:0);assert.equal(r.status,allowed?200:404);
  }
});

test('all current connection, approval, STOP and alert routes reach the backend',async()=>{
  const paths=['/owner-app','/owner-app/index.html','/owner-app/app.css',
    '/auth/sign-in','/auth/sign-out','/auth/gmail/connect','/.well-known/oauth-protected-resource',
    '/oauth/register','/owner/me','/owner/connect','/owner/jobs','/owner/pending','/owner/receipts',
    '/owner/stop','/owner/agent-connections/revoke','/owner/agent-connections/secret-path',
    '/owner/agent-connections/secret-path-new','/owner/jobs/confirm','/owner/versions/approve',
    '/owner/versions/reject','/owner/dispatches/resolve','/owner/integrations','/owner/alerts/test'];
  for(const path of paths){
    let calls=0;
    const r=await createWorker(async(req)=>{calls++;assert.equal(req.url,UPSTREAM_ORIGIN+path);return new Response('backend-owned refusal',{status:405});}).fetch(request(path,{method:'OPTIONS'}));
    assert.equal(calls,1);assert.equal(r.status,405);
  }
});

test('unlisted routes and malformed secret paths never reach the upstream',async()=>{
  for(const path of ['/unknown-route','/owner/admin','/owner/jobs/extra','/oauth/token/extra',
    '/owner-app/receipt-key.json','/config.json','/about/','/mcp/c/'+ 'a'.repeat(42),
    '/mcp/c/'+ 'a'.repeat(44),'/mcp/c/'+ 'a'.repeat(42)+'%2F','/mcp/c/'+ 'a'.repeat(43)+'/extra']){
    const r=await createWorker(noFetch).fetch(request(path));assert.equal(r.status,404);
  }
});

test('Origin is never repaired; upstream rejection is returned',async()=>{
  const r=await createWorker(async(req)=>{
    assert.equal(req.headers.get('origin'),'null');return new Response('denied',{status:403});
  }).fetch(request('/oauth/authorize',{method:'POST',headers:{origin:'null'},body:'fixture'}));
  assert.equal(r.status,403);assert.equal(await r.text(),'denied');
});

test('HEAD and CORS OPTIONS retain response status and headers',async()=>{
  for(const method of ['HEAD','OPTIONS']){
    const r=await createWorker(async(req)=>{
      assert.equal(req.method,method);return new Response(null,{status:204,headers:{allow:'GET, POST, OPTIONS','access-control-allow-headers':'authorization, content-type, accept, mcp-protocol-version'}});
    }).fetch(request('/mcp',{method}));
    assert.equal(r.status,204);assert.equal(await r.text(),'');assert.equal(r.headers.get('allow'),'GET, POST, OPTIONS');
  }
});

test('upstream body is streamed without consuming or editing it',async()=>{
  const upstream=new Response('data: fixture\n\n',{headers:{'content-type':'text/event-stream'}});
  const r=await createWorker(async()=>upstream).fetch(request('/mcp'));
  assert.equal(upstream.bodyUsed,false);assert.equal(r.body,upstream.body);
  assert.equal(r.headers.get('content-type'),'text/event-stream');assert.equal(await r.text(),'data: fixture\n\n');
});

test('failed upstream is attempted once; private error details are not returned',async()=>{
  let calls=0;
  const r=await createWorker(async()=>{calls++;throw Error('fixture-private-provider-detail');}).fetch(request('/oauth/token',{method:'POST',body:'fixture'}));
  assert.equal(calls,1);assert.equal(r.status,502);assert.equal(await r.text(),'Upstream unavailable');
});

test('foreign origins fail before any upstream request',async()=>{
  for(const origin of ['https://other.example','http://speedwrit.aidenid.com','https://speedwrit.aidenid.com:444']){
    const r=await createWorker(noFetch).fetch(new Request(origin+'/mcp'));
    assert.equal(r.status,404);
  }
});

test('public CSS remains local and a response without Cache-Control gains no-store/no-transform',async()=>{
  const css=await createWorker(noFetch).fetch(request('/public.css'));
  assert.equal(css.status,200);assert.match(css.headers.get('content-type'),/text\/css/);
  assert.equal(css.headers.get('cache-control'),'no-store, no-transform');
  const r=await createWorker(async()=>new Response('fixture')).fetch(request('/owner/me'));
  assert.equal(r.headers.get('cache-control'),'no-store, no-transform');
});
