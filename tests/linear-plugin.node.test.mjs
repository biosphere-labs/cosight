import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLinearConnector} from '../assets/plugins/linear.js';
const origin='https://mcp.linear.app',callbackUrl='http://127.0.0.1:9876/plugins/linear/callback';
function fake(){
 const calls=[];let refreshes=0;
 const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
 async function fetchImpl(url,init={}){
  const u=new URL(url),body=init.body?String(init.body):'';calls.push({url:u.href,init,body});
  if(u.pathname.includes('oauth-protected-resource'))return json({resource:origin+'/mcp/readonly',authorization_servers:[origin],scopes_supported:['read','write']});
  if(u.pathname.includes('oauth-authorization-server'))return json({issuer:origin,authorization_endpoint:origin+'/authorize',token_endpoint:origin+'/token',registration_endpoint:origin+'/register',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none']});
  if(u.pathname==='/register'){assert.equal(JSON.parse(body).scope,'read');return json({client_id:'public-client',redirect_uris:[callbackUrl],token_endpoint_auth_method:'none'},201);}
  if(u.pathname==='/token'){const p=new URLSearchParams(body);if(p.get('grant_type')==='refresh_token')refreshes++;else{assert.ok(p.get('code_verifier'));assert.equal(p.get('redirect_uri'),callbackUrl);}return json({access_token:'private-access',refresh_token:'private-refresh',token_type:'Bearer',expires_in:3600});}
  assert.equal(u.pathname,'/mcp/readonly');
  if(init.method==='GET')return new Response(null,{status:405});
  const rpc=JSON.parse(body);if(!rpc.id&&rpc.id!==0)return new Response(null,{status:202});
  assert.equal(new Headers(init.headers).get('authorization'),'Bearer private-access');
  let result;
  if(rpc.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fake-linear',version:'1'}};
  else if(rpc.method==='tools/call'){
   const {name,arguments:args}=rpc.params;assert.ok(['list_projects','list_issues','get_issue','list_comments'].includes(name));
   let value=name==='list_projects'?{projects:[{id:'p1',name:'CoSight'}],hasNextPage:true,cursor:'page2'}:name==='list_issues'?{issues:[{id:args.cursor?'i2':'i1',identifier:'EX-123'}],hasNextPage:false}:name==='list_comments'?[{id:'c1',body:'Decision'}]:{id:'i1',identifier:'EX-123',title:'Connect Linear',description:'Evidence',url:'https://linear.app/example-workspace/issue/EX-123'};
   result={content:[{type:'text',text:JSON.stringify(value)}]};
  } else throw Error('Unexpected RPC '+rpc.method);
  return json({jsonrpc:'2.0',id:rpc.id,result});
 }
 return {fetchImpl,calls,get refreshes(){return refreshes;}};
}
async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'cosight-linear-'));const server=fake();const connector=createLinearConnector({root,callbackUrl,fetchImpl:server.fetchImpl});t.after(async()=>{await connector.close();await rm(root,{recursive:true,force:true});});return {root,server,connector};}
async function signIn(connector){const started=await connector.begin();assert.equal(new URL(started.url).searchParams.get('scope'),'read');assert.equal(new URL(started.url).searchParams.get('code_challenge_method'),'S256');return connector.finish({code:'authorization-code',state:started.state});}

test('real SDK OAuth DCR, PKCE, private persistence, MCP pagination and evidence',async t=>{
 const {root,connector,server}=await fixture(t);assert.deepEqual(await connector.status(),{connected:false,state:'disconnected'});
 assert.equal((await signIn(connector)).connected,true);
 const credentials=path.join(root,'linear-private/oauth.json');assert.equal((await stat(credentials)).mode&0o777,0o600);assert.equal((await stat(path.dirname(credentials))).mode&0o777,0o700);
 const projects=await connector.request('projects',{query:'CoSight',limit:5});assert.equal(projects.nextCursor,'page2');
 await connector.request('issues',{project:'p1',cursor:'page2'});
 const issue=await connector.request('issue',{id:'EX-123'});assert.equal(issue.description,'Evidence');assert.ok(Date.parse(issue.retrievedAt));assert.equal((await connector.status()).workspace.id,'example-workspace');
 assert.equal((await connector.request('discussion',{id:'i1'})).items[0].body,'Decision');
 assert.ok(!JSON.stringify(await connector.status()).includes('private-access'));
 assert.ok((await readFile(credentials,'utf8')).includes('private-refresh'));
 assert.equal(server.calls.filter(x=>x.url.endsWith('/register')).length,1);
});

test('normalizes official issue id/uuid records and pasted Linear URLs',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'cosight-linear-shape-')),server=fake();
 const connector=createLinearConnector({root,callbackUrl,fetchImpl:async(url,init)=>{
  const response=await server.fetchImpl(url,init);
  const rpc=init?.body?JSON.parse(String(init.body).startsWith('{')?String(init.body):'{}'):{};
  if(rpc.params?.name!=='get_issue')return response;
  assert.equal(rpc.params.arguments.id,'EX-123');const body=await response.json();body.result.content[0].text=JSON.stringify({id:'EX-123',uuid:'immutable-uuid',title:'Official shape',url:'https://linear.app/example-workspace/issue/EX-123',description:'Actual adapter shape'});return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
 }});t.after(async()=>{await connector.close();await rm(root,{recursive:true,force:true});});
 await signIn(connector);const issue=await connector.request('issue',{id:'https://linear.app/example-workspace/issue/EX-123/a-title'});assert.equal(issue.id,'immutable-uuid');assert.equal(issue.identifier,'EX-123');
 await assert.rejects(connector.request('issue',{id:'https://example.com/issue/EX-123'}),/Linear issue URL/);
});
test('declining a state-matched OAuth request clears pending authorization',async t=>{
 const {connector}=await fixture(t);const request=await connector.begin();
 await assert.rejects(connector.finish({state:'unmatched',error:'access_denied'}),/state/);assert.equal((await connector.status()).state,'authorizing');
 await assert.rejects(connector.finish({state:request.state,error:'access_denied'}),/declined/);assert.deepEqual(await connector.status(),{connected:false,state:'disconnected'});
 await assert.rejects(connector.finish({state:request.state,code:'late-code'}),/state/);
});
test('rejects state mismatch, unsolicited callback, replay, mutation operations and passthrough tools',async t=>{
 const {connector,server}=await fixture(t);await assert.rejects(connector.finish({code:'x',state:'x'}),/state/);
 const start=await connector.begin();await assert.rejects(connector.finish({code:'x',state:start.state+'x'}),/state/);assert.equal(server.calls.filter(x=>x.url.endsWith('/token')).length,0);
 await connector.finish({code:'x',state:start.state});await assert.rejects(connector.finish({code:'x',state:start.state}),/state/);
 for(const operation of ['create_issue','update_issue','__proto__','tools/call'])await assert.rejects(connector.request(operation,{}),/read-only/);
});
test('expired access token refreshes through SDK and persisted client registration is reused',async t=>{
 const {root,connector,server}=await fixture(t);await signIn(connector);await connector.close();
 const {writeFile}=await import('node:fs/promises');const file=path.join(root,'linear-private/oauth.json');const data=JSON.parse(await readFile(file));data.expiresAt=Date.now()-1;await writeFile(file,JSON.stringify(data));
 const next=createLinearConnector({root,callbackUrl,fetchImpl:server.fetchImpl});t.after(()=>next.close());await next.request('projects');assert.equal(server.refreshes,1);assert.equal(server.calls.filter(x=>x.url.endsWith('/register')).length,1);
});
test('disconnect deletes private credentials; close retains them; both reject active calls',async t=>{
 const {root,connector}=await fixture(t);await signIn(connector);await connector.disconnect();assert.equal((await connector.status()).connected,false);await assert.rejects(readFile(path.join(root,'linear-private/oauth.json')),e=>e.code==='ENOENT');await assert.rejects(connector.request('projects'),/sign in/);await connector.close();await assert.rejects(connector.request('projects'),/closed/);
});
test('caller cancellation reaches SDK request and blocks already-aborted operations',async t=>{
 const {connector}=await fixture(t);await signIn(connector);const abort=new AbortController();abort.abort();await assert.rejects(connector.request('issues',{}, {signal:abort.signal}),e=>e.name==='AbortError');
});
test('rejects non-loopback callbacks and foreign OAuth endpoint discovery',async t=>{
 for(const callbackUrl of ['https://example.com/callback','http://localhost:1234/callback','http://127.0.0.1/callback'])assert.throws(()=>createLinearConnector({root:'/tmp/private',callbackUrl}),/callback/);
 const {root}=await fixture(t);const connector=createLinearConnector({root,callbackUrl,fetchImpl:async()=>new Response(JSON.stringify({resource:origin+'/mcp/readonly',authorization_servers:['https://evil.example']}),{headers:{'content-type':'application/json'}})});t.after(()=>connector.close());await assert.rejects(connector.begin(),/sign-in could not start/);
});
for(const action of ['disconnect','close'])test(action+' cancels an outstanding HTTP read without late credential writes',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'cosight-linear-cancel-'));const server=fake();let entered,aborted=false;const ready=new Promise(resolve=>entered=resolve);
 const connector=createLinearConnector({root,callbackUrl,fetchImpl:async(url,init)=>{
  const rpc=init.body&&String(init.body).startsWith('{')?JSON.parse(init.body):null;
  if(rpc?.method==='tools/call'){entered();return new Promise((resolve,reject)=>{init.signal.addEventListener('abort',()=>{aborted=true;reject(init.signal.reason);},{once:true});});}
  return server.fetchImpl(url,init);
 }});t.after(async()=>{await connector.close();await rm(root,{recursive:true,force:true});});
 await signIn(connector);const request=connector.request('projects');const rejection=assert.rejects(request);await ready;await connector[action]();await rejection;assert.equal(aborted,true);
 if(action==='disconnect')await assert.rejects(readFile(path.join(root,'linear-private/oauth.json')),e=>e.code==='ENOENT');
});
test('persisted connection survives a new local callback port without returning credentials',async t=>{
 const {root,connector,server}=await fixture(t);await signIn(connector);await connector.close();
 const next=createLinearConnector({root,callbackUrl:'http://127.0.0.1:9877/plugins/linear/callback',fetchImpl:server.fetchImpl});t.after(()=>next.close());
 assert.equal((await next.status()).connected,true);assert.deepEqual(await next.begin(),{url:null,state:''});await next.request('projects');assert.equal(server.calls.filter(x=>x.url.endsWith('/register')).length,1);
});
