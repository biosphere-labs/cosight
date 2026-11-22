import {mkdir,readFile,writeFile,rename,chmod,rm} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {auth} from '@modelcontextprotocol/sdk/client/auth.js';

// Official endpoint and OAuth contract: https://linear.app/docs/mcp .
const ORIGIN='https://mcp.linear.app';
const SERVER=ORIGIN+'/mcp/readonly';
const operations=Object.freeze({projects:'list_projects',issues:'list_issues',issue:'get_issue',discussion:'list_comments'});
function trusted(value){const u=new URL(value);if(u.origin!==ORIGIN||u.username||u.password)throw Error('Linear returned an untrusted server URL');return u;}
function unpack(result){
  if(result.isError)throw Error('Linear could not complete this read request');
  if(result.structuredContent)return result.structuredContent;
  const texts=(result.content||[]).filter(x=>x.type==='text').map(x=>x.text);
  for(const value of texts){try{return JSON.parse(value);}catch{}}
  throw Error('Linear returned an unsupported response; reconnect or update CoSight');
}
function page(value,key){
  const items=Array.isArray(value)?value:value?.[key]??value?.items??value?.nodes;
  if(!Array.isArray(items))throw Error('Linear returned an invalid '+key+' list');
  const info=value?.pageInfo;
  const cursor=value?.nextCursor??value?.cursor??info?.endCursor??null;
  if((value?.hasNextPage===true||info?.hasNextPage===true)&&!cursor)throw Error('Linear omitted the next page cursor');
  return {items,nextCursor:(value?.hasNextPage===false||info?.hasNextPage===false)?null:cursor};
}
/** App-owned read-only OAuth; root must be private application data, never project settings. */
export function createLinearConnector({root,callbackUrl,fetchImpl=globalThis.fetch}){
  const redirect=new URL(callbackUrl);
  if(redirect.protocol!=='http:'||redirect.hostname!=='127.0.0.1'||!redirect.port||redirect.username||redirect.password||redirect.search||redirect.hash)throw Error('Linear callback must be a local 127.0.0.1 HTTP URL with a port');
  if(!path.isAbsolute(root))throw Error('Linear credentials require an absolute app-data root');
  const directory=path.join(root,'linear-private'),file=path.join(directory,'oauth.json');
  let data={},loaded,client,connecting,closed=false,pending,error,writeQueue=Promise.resolve(),generation=0;
  let lifetime=new AbortController();
  const assertOpen=()=>{if(closed)throw Error('Linear connector is closed');};
  async function load(){if(!loaded)loaded=(async()=>{try{data=JSON.parse(await readFile(file,'utf8'));await chmod(file,0o600);}catch(e){if(e.code!=='ENOENT')throw Error('Cannot read private Linear credentials');}})();await loaded;}
  async function save(){const snapshot=JSON.stringify({...data,callbackUrl});const epoch=generation;writeQueue=writeQueue.then(async()=>{if(epoch!==generation||closed)return;await mkdir(directory,{recursive:true,mode:0o700});await chmod(directory,0o700);const temp=file+'.tmp';await writeFile(temp,snapshot,{mode:0o600});await chmod(temp,0o600);await rename(temp,file);});await writeQueue;}
  async function safeFetch(url,init={}){assertOpen();trusted(url instanceof Request?url.url:String(url));const epoch=generation;const signal=AbortSignal.any([lifetime.signal,...(init.signal?[init.signal]:[])]);const response=await fetchImpl(url,{...init,redirect:'error',signal});signal.throwIfAborted();if(epoch!==generation)throw Error('Linear connection changed');return response;}
  const provider={
    redirectUrl:callbackUrl,
    clientMetadata:{client_name:'CoSight',redirect_uris:[callbackUrl],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none',scope:'read'},
    state:()=>{if(!pending)throw Error('Start Linear sign-in first');return pending.state;},
    clientInformation:()=>data.client,
    saveClientInformation:async value=>{trusted(value.issuer||ORIGIN);data.client=value;data.clientRedirectUrl=callbackUrl;await save();},
    tokens:()=>data.tokens,
    saveTokens:async value=>{trusted(value.issuer||ORIGIN);data.tokens={...value,refresh_token:value.refresh_token??data.tokens?.refresh_token};data.expiresAt=value.expires_in?Date.now()+value.expires_in*1000:null;await save();},
    saveCodeVerifier:value=>{if(!pending)throw Error('Start Linear sign-in first');pending.verifier=value;},
    codeVerifier:()=>{if(!pending?.verifier)throw Error('Linear sign-in expired; connect again');return pending.verifier;},
    redirectToAuthorization:value=>{trusted(value);if(value.searchParams.get('scope')!=='read')throw Error('Linear requested unexpected access');if(!pending)throw Error('Reconnect Linear in CoSight');pending.url=value.href;},
    saveDiscoveryState:async value=>{trusted(value.authorizationServerUrl);for(const key of ['issuer','authorization_endpoint','token_endpoint','registration_endpoint'])if(value.authorizationServerMetadata?.[key])trusted(value.authorizationServerMetadata[key]);data.discovery=value;await save();},
    discoveryState:()=>data.discovery,
    invalidateCredentials:async scope=>{if(scope==='all')data={};else if(scope==='client')delete data.client;else if(scope==='tokens')delete data.tokens;else if(scope==='discovery')delete data.discovery;else if(scope==='verifier'&&pending)delete pending.verifier;await save();}
  };
  function statusValue(){return {connected:!!data.tokens?.access_token&&!error&&!closed,state:closed?'closed':pending?'authorizing':error?'reconnect-required':data.tokens?.access_token?'connected':'disconnected',...(data.workspace?{workspace:data.workspace}:{}),...(error?{error}:{})};}
  async function resetConnection(){const old=client;client=undefined;connecting=undefined;if(old)await old.close().catch(()=>{});}
  async function authorize(code){return auth(provider,{serverUrl:SERVER,scope:'read',...(code?{authorizationCode:code}:{}),fetchFn:safeFetch});}
  async function ensureClient(){
    assertOpen();await load();if(client&&data.expiresAt&&data.expiresAt<Date.now()+30000)await resetConnection();if(client)return client;if(connecting)return connecting;if(!data.tokens?.access_token)throw Error('Connect Linear in CoSight to sign in');
    connecting=(async()=>{
      if(!data.tokens?.access_token)throw Error('Connect Linear in CoSight to sign in');
      if(data.expiresAt&&data.expiresAt<Date.now()+30000){if(!data.tokens.refresh_token)throw Error('Linear sign-in expired; reconnect in CoSight');if(await authorize()!=='AUTHORIZED')throw Error('Reconnect Linear in CoSight');}
      const next=new Client({name:'CoSight',version:'1.0.0'});
      const transport=new StreamableHTTPClientTransport(new URL(SERVER),{fetch:safeFetch,requestInit:{headers:{Authorization:'Bearer '+data.tokens.access_token}}});
      try{await next.connect(transport);assertOpen();client=next;return next;}catch(e){await next.close().catch(()=>{});throw e;}
    })().catch(e=>{error='Linear connection failed. Reconnect in CoSight, then try again.';throw Error(error);}).finally(()=>{connecting=undefined;});return connecting;
  }
  return {
    async status(){await load();return statusValue();},
    async begin(){assertOpen();await load();await resetConnection();error=undefined;if(data.tokens?.access_token){try{await ensureClient();return {url:null,state:''};}catch{await resetConnection();delete data.tokens;error=undefined;}}if(data.clientRedirectUrl!==callbackUrl)delete data.client;pending={state:randomBytes(32).toString('base64url'),createdAt:Date.now()};
      try{const outcome=await authorize();if(outcome==='AUTHORIZED'){pending=undefined;await ensureClient();return {url:null,state:''};}return {url:pending.url,state:pending.state};}catch(e){pending=undefined;error='Linear sign-in could not start. Check your connection and try again.';throw Error(error);}},
    async finish({code,state,error:authorizationError}={}){assertOpen();await load();const a=Buffer.from(String(state||'')),b=Buffer.from(pending?.state||'');if(!pending||a.length!==b.length||!timingSafeEqual(a,b)||Date.now()-pending.createdAt>10*60*1000)throw Error('Linear sign-in state is invalid or expired; connect again');if(authorizationError){pending=undefined;throw Error('Linear authorization was declined. Connect again in CoSight.');}if(typeof code!=='string'||!code||code.length>8192)throw Error('Linear sign-in did not return an authorization code');
      try{await authorize(code);pending=undefined;error=undefined;await ensureClient();return statusValue();}catch(e){pending=undefined;error='Linear sign-in failed. Connect again in CoSight.';throw Error(error);}},
    async disconnect(){assertOpen();generation++;lifetime.abort();lifetime=new AbortController();await resetConnection();await load();data={};pending=undefined;error=undefined;await writeQueue.catch(()=>{});await rm(directory,{recursive:true,force:true});return statusValue();},
    async close(){closed=true;generation++;pending=undefined;lifetime.abort();await resetConnection();await writeQueue.catch(()=>{});},
    async request(operation,input={}, {signal}={}){
      assertOpen();if(!Object.hasOwn(operations,operation))throw Error('Unsupported read-only Linear operation');signal?.throwIfAborted();
      const active=await ensureClient();const args={};
      const keys=operation==='projects'?['query','team','limit','cursor','includeArchived']:operation==='issues'?['query','project','team','limit','cursor','includeArchived']:operation==='issue'?['id','includeRelations']:['issueId'];
      for(const key of keys)if(input[key]!==undefined)args[key]=input[key];
      if(operation==='issue'&&typeof args.id==='string'&&/^https?:/.test(args.id)){
        const url=new URL(args.id);if(url.origin!=='https://linear.app')throw Error('Paste a Linear issue URL or identifier');
        const match=/\/issue\/([A-Za-z][A-Za-z0-9_]*-\d+)(?:\/|$)/.exec(url.pathname);if(!match)throw Error('Paste a Linear issue URL or identifier');args.id=match[1];
      }
      if(operation==='discussion'&&!args.issueId)args.issueId=input.id;
      if((operation==='issue'&&!args.id)||(operation==='discussion'&&!args.issueId))throw Error('Choose a Linear issue first');
      const combined=AbortSignal.any([lifetime.signal,...(signal?[signal]:[])]);
      let response;try{response=await active.callTool({name:operations[operation],arguments:args},undefined,{signal:combined});}catch(e){if(combined.aborted)throw combined.reason;if(e.code===401||e.code===403){error='Linear sign-in expired or access was revoked. Reconnect in CoSight.';await resetConnection();throw Error(error);}throw Error('Linear could not complete this read. Check your connection and try again.');}const value=unpack(response);
      if(operation==='issue'){
        const issue=value.issue??value;
        const identifier=issue.identifier||(/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(issue.id||'')?issue.id:null);
        if(!issue.id||!identifier||!issue.title||!issue.url)throw Error('Linear returned incomplete issue evidence');
        const issueUrl=new URL(issue.url);if(issueUrl.origin!=='https://linear.app')throw Error('Linear returned an invalid issue URL');
        const slug=issueUrl.pathname.split('/').filter(Boolean)[0];
        if(slug){data.workspace={id:slug,name:slug,url:'https://linear.app/'+encodeURIComponent(slug)};await save();}
        return {id:issue.uuid||issue.id,identifier,title:issue.title,description:issue.description||'',url:issue.url,retrievedAt:new Date().toISOString(),...(Array.isArray(issue.comments)?{comments:issue.comments}:{})};
      }
      return page(value,operation==='projects'?'projects':operation==='issues'?'issues':'comments');
    }
  };
}
