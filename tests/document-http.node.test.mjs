import {test} from 'node:test';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fork,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
const serverFile=fileURLToPath(new URL('../assets/tour-server.js',import.meta.url));
async function setup(t,{webOrigin}={}){
 const folder=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cosight-document-http-'))),root=path.join(folder,'appdata'),project=path.join(folder,'project');fs.mkdirSync(root);fs.mkdirSync(project);
 let errors='';const child=fork(serverFile,[root,'0','127.0.0.1'],{env:{...process.env,KOKORO_ENSURE:'',...(webOrigin?{COSIGHT_WEB_ORIGIN:webOrigin}:{})},stdio:['ignore','ignore','pipe','ipc']});child.stderr.on('data',b=>errors+=b);t.after(async()=>{child.kill('SIGTERM');if(child.exitCode===null)await once(child,'exit');fs.rmSync(folder,{recursive:true,force:true});});
 const port=await Promise.race([once(child,'message').then(([m])=>m.port),once(child,'exit').then(([code])=>{throw Error('Server exited '+code+': '+errors);}),new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Server startup timeout: '+errors)),10000);timer.unref();})]);
 const origin='http://127.0.0.1:'+port;
 async function request(route,{method='GET',body,headers={},raw}={}){const response=await fetch(origin+route,{method,headers:{...(method==='POST'?{'content-type':'application/json',origin}:{}),...headers},...(body!==undefined||raw!==undefined?{body:raw??JSON.stringify(body)}:{})});let value;try{value=await response.json();}catch{value=null;}return {status:response.status,value};}
 const get=(route,file)=>request(route+'?project='+encodeURIComponent(project)+(file===undefined?'':'&path='+encodeURIComponent(file)));
 const post=(route,input={},options={})=>request(route,{method:'POST',body:{project,...input},...options});
 return {folder,root,project,origin,request,get,post};
}
const git=(project,...args)=>execFileSync('git',args,{cwd:project,encoding:'utf8'}).trim();
function files(directory){return fs.readdirSync(directory,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(directory,e.name)):[path.join(directory,e.name)]);}

test('HTTP discovers and selects existing Markdown, stores path-only metadata and rereads changed source in place',async t=>{
 const f=await setup(t),file=path.join(f.project,'handover.md'),text='# Handover\nExisting source marker: NO_IMPORTED_COPY\n';fs.writeFileSync(file,text);fs.writeFileSync(path.join(f.project,'README.md'),'# Readme\n');
 const before=(await f.get('/documents')).value;assert.equal(before.selectedPath,null);assert.equal(before.documents[0].path,file);assert.equal((await f.post('/documents/select',{path:file})).status,200);
 const listed=(await f.get('/documents')).value;assert.equal(listed.selectedPath,file);const doc=(await f.get('/documents/read')).value;assert.equal(doc.text,text);assert.equal(doc.path,file);assert.equal(doc.sections[0].title,'Handover');
 const stored=files(f.root);assert.equal(stored.length,1);assert.deepEqual(JSON.parse(fs.readFileSync(stored[0])),{path:file});assert.ok(!fs.readFileSync(stored[0],'utf8').includes('NO_IMPORTED_COPY'));
 fs.appendFileSync(file,'Updated in place.\n');const refreshed=(await f.get('/documents/read')).value;assert.notEqual(refreshed.hash,doc.hash);assert.equal(refreshed.text,text+'Updated in place.\n');assert.equal(fs.readFileSync(file,'utf8'),refreshed.text);
 fs.unlinkSync(file);const deleted=await f.get('/documents/read');assert.equal(deleted.status,400);assert.match(deleted.value.error,/moved|deleted|exist/i);assert.equal((await f.post('/documents/start',{path:file})).status,400);
});

test('HTTP rejects unsafe, missing, binary, oversize and unsupported source; external Markdown is referenced without importing',async t=>{
 const f=await setup(t);for(const [name,bytes] of [['huge.md',Buffer.alloc(1024*1024+1,65)],['binary.md',Buffer.from([0,1,2])],['invalid.md',Buffer.from([255])],['notes.txt',Buffer.from('unsupported')]])fs.writeFileSync(path.join(f.project,name),bytes);
 const outside=path.join(f.folder,'outside.markdown');fs.writeFileSync(outside,'# External source\n');fs.symlinkSync(outside,path.join(f.project,'link.md'));
 for(const name of ['missing.md','huge.md','binary.md','invalid.md','notes.txt','link.md','../outside.markdown'])assert.equal((await f.get('/documents/read',name)).status,400,name);
 const selected=await f.post('/documents/select',{path:outside});assert.equal(selected.status,200);assert.equal(selected.value.text,'# External source\n');assert.equal(fs.readFileSync(outside,'utf8'),'# External source\n');assert.equal(files(f.root).length,1);
});

test('reference endpoint requires document evidence and enabled Git, resolves real commit parents without executing document commands',async t=>{
 const f=await setup(t),sentinel=path.join(f.folder,'SHOULD_NOT_EXIST');git(f.project,'init','--quiet','-b','main');git(f.project,'config','user.email','fixture@example.test');git(f.project,'config','user.name','Fixture');fs.writeFileSync(path.join(f.project,'main.js'),'export const n=1;\n');git(f.project,'add','.');git(f.project,'commit','--quiet','-m','Base');const base=git(f.project,'rev-parse','HEAD');fs.writeFileSync(path.join(f.project,'main.js'),'export const n=2;\n');git(f.project,'commit','--quiet','-am','Next');const head=git(f.project,'rev-parse','HEAD');
 const file=path.join(f.project,'handover.md'),text='# Handover\ncommit: '+head+'\nbranch: main\nbranch: nonexistent-checkpoint\n```sh\ntouch '+sentinel+'\n```\n';fs.writeFileSync(file,text);const before=git(f.project,'status','--porcelain=v1');
 const ref=()=>f.post('/documents/reference',{path:file,value:head});let response=await ref();assert.equal(response.status,200);assert.equal(response.value.resolved,false);assert.match(response.value.message,/install|enable/i);
 await f.post('/plugins',{plugin:'git',operation:'install'});assert.equal((await ref()).value.resolved,false);await f.post('/plugins',{plugin:'git',operation:'enable'});
 response=await ref();assert.equal(response.value.resolved,true);assert.equal(response.value.sha,head);assert.deepEqual(response.value.parents,[base]);assert.equal(response.value.subject,'Next');
 assert.equal((await f.post('/documents/reference',{path:file,value:'main'})).value.sha,head);assert.equal((await f.post('/documents/reference',{path:file,value:base})).value.resolved,false);assert.equal((await f.post('/documents/reference',{path:file,value:'nonexistent-checkpoint'})).value.resolved,false);
 await f.post('/documents/select',{path:file});assert.equal(fs.existsSync(sentinel),false);assert.equal(fs.readFileSync(file,'utf8'),text);assert.equal(git(f.project,'rev-parse','HEAD'),head);assert.equal(git(f.project,'status','--porcelain=v1'),before);
 await f.post('/plugins',{plugin:'git',operation:'disable'});assert.equal((await ref()).value.resolved,false);
});

test('document POST routes enforce JSON, bounded parsing and local/configured origins; UI assets and API14 are served',async t=>{
 const configured='http://127.0.0.1:43119',f=await setup(t,{webOrigin:configured}),file=path.join(f.project,'README.md');fs.writeFileSync(file,'# Notes\n');
 for(const route of ['/documents/select','/documents/start','/documents/reference']){
  assert.equal((await f.post(route,{path:file},{headers:{origin:'https://evil.example'}})).status,403);assert.equal((await f.post(route,{path:file},{headers:{'content-type':'text/plain'}})).status,415);
  assert.equal((await f.request(route,{method:'POST',raw:'{',headers:{origin:f.origin}})).status,400);assert.equal((await f.request(route,{method:'POST',raw:'[]'})).status,400);
 }
 for(const origin of [configured,f.origin,f.origin.replace('127.0.0.1','localhost')])assert.equal((await f.post('/documents/select',{path:file},{headers:{origin}})).status,200);
 assert.equal((await f.post('/documents/start',{path:file,text:{not:'text'}})).status,400);
 let oversize;try{oversize=await f.post('/documents/select',{path:file,text:'x'.repeat(129*1024)});}catch(error){assert.match(error.message,/fetch failed|socket|network/i);}if(oversize)assert.ok(oversize.status>=400);
 assert.equal((await f.request('/whoami')).value.api,17);for(const asset of ['/document-ui.js','/document.css','/document-contracts.js'])assert.equal((await fetch(f.origin+asset)).status,200,asset);
});


test('document start HTTP binds real reader hash and custom CLI delivers diagram-only plus verified-code stops through real MCP',async t=>{
 const f=await setup(t),file=path.join(f.project,'handover.md'),text='# Guide\nArchitecture claim.\n\nCode: source.js\n',source='export const answer = 42;\n';fs.writeFileSync(file,text);fs.writeFileSync(path.join(f.project,'source.js'),source);
 const writer=fileURLToPath(new URL('../assets/agent-mcp.js',import.meta.url)),sdk=fileURLToPath(new URL('../node_modules/@modelcontextprotocol/sdk/dist/esm/client/',import.meta.url)),script=path.join(f.folder,'fixture-provider.mjs');
 fs.writeFileSync(script,`import fs from 'node:fs';import path from 'node:path';import {Client} from ${JSON.stringify('file://'+path.join(sdk,'index.js'))};import {StdioClientTransport} from ${JSON.stringify('file://'+path.join(sdk,'stdio.js'))};
 const runDir=process.argv[2],descriptor=path.join(runDir,'run.json'),client=new Client({name:'document-http-fixture',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[${JSON.stringify(writer)},'cosight',descriptor],stderr:'pipe'}));
 async function call(name,args){const result=await client.callTool({name,arguments:args});if(result.isError)throw Error(JSON.stringify(result));return result;}
 try{await call('read_document',{});await call('read_source',{path:'source.js'});await call('plan',{question:'Explain the guide',stops:['Concept','Relevant code'],overview:'flowchart LR\\n A["Concept"] --> B["Code"]'});await call('show',{stop:1,title:'Concept',say:'The document records an architecture claim.',svg:'flowchart LR\\n A["Claim"] --> B["Needs evidence"]',codeRelevant:false,documentStart:1,documentEnd:2});await call('show',{stop:2,title:'Code',say:'The source exports the answer value.',svg:'flowchart LR\\n A["Source"] --> B["Answer"]',codeRelevant:true,documentStart:4,documentEnd:4,file:'source.js',start:1,end:1});}finally{await client.close();}`);
 const settings=await f.post('/settings',{instructions:'Project addition fixture',agent:{provider:'custom',command:process.execPath,args:[script,'{runDir}']},serena:{enabled:false,command:'unused',args:[]}});assert.equal(settings.status,200);
 const preview=(await f.get('/documents/read',file)).value;
 fs.writeFileSync(file,text+'A new document claim.\n');
 for(const route of ['/documents/start','/documents/reference']){const stale=await f.post(route,{path:file,hash:preview.hash,value:'HEAD'});assert.equal(stale.status,400);assert.match(stale.value.error,/changed|refresh/i);}
 assert.equal((await f.request('/agent/status')).value.running,false);assert.equal(fs.existsSync(path.join(f.root,'runs')),false);
 const refreshed=(await f.get('/documents/read',file)).value;assert.notEqual(refreshed.hash,preview.hash);
 const result=await f.post('/documents/start',{path:file,hash:refreshed.hash,text:'Explain guide in two stops'});assert.equal(result.status,200,result.value?.error);const runDir=result.value.runDir;assert.ok(runDir);
 for(let i=0;i<200;i++){if(!(await f.request('/agent/status')).value.running)break;await new Promise(r=>setTimeout(r,25));}
 const status=(await f.request('/agent/status')).value;assert.equal(status.running,false);assert.equal(status.error,'');
 const descriptor=JSON.parse(fs.readFileSync(path.join(runDir,'run.json'))),tour=JSON.parse(fs.readFileSync(path.join(f.root,'tour.json')));assert.equal(descriptor.documentContext.path,file);assert.equal(descriptor.documentContext.hash,(await f.get('/documents/read',file)).value.hash);assert.equal(tour.stops.length,2);
 const pure=tour.stops[0],mixed=tour.stops[1];assert.equal(pure.codeRelevant,false);assert.equal(pure.mode,'map');assert.equal(pure.fileUrl,'');assert.equal(pure.document.path,file);assert.equal(mixed.codeRelevant,true);assert.equal(mixed.mode,'split');assert.equal(mixed.file,'source.js');assert.equal(fs.readFileSync(path.join(f.root,mixed.fileUrl),'utf8'),source);
 const events=fs.readFileSync(path.join(runDir,'tools.jsonl'),'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));assert.ok(events.some(e=>e.type==='cosight.tool'&&e.name==='read_document'));assert.equal(events.filter(e=>e.type==='cosight.tool'&&e.name==='show').length,2);assert.equal(fs.readFileSync(file,'utf8'),text+'A new document claim.\n');assert.equal(fs.readFileSync(path.join(f.project,'source.js'),'utf8'),source);assert.equal(fs.existsSync(path.join(f.project,'.git')),false);
});


test('desktop document bridge selects Markdown with mocked Electron only and API upgrade remains aligned',async()=>{
 const require=createRequire(import.meta.url),handlers=new Map(),dialogCalls=[];let exposed;
 const electron={app:{requestSingleInstanceLock:()=>true,on(){},whenReady:()=>({then:()=>({catch(){}})})},BrowserWindow:function(){},ipcMain:{handle:(name,handler)=>handlers.set(name,handler)},dialog:{async showOpenDialog(win,options){dialogCalls.push(options);return {canceled:false,filePaths:['/existing/guide.markdown']};}},shell:{}};
 const main=fs.readFileSync(new URL('../electron/main.cjs',import.meta.url),'utf8');vm.runInNewContext(main,{require:name=>name==='electron'?electron:require(name),__dirname:fileURLToPath(new URL('../electron/',import.meta.url)),process:{env:{},platform:'linux'},console});
 assert.equal(await handlers.get('choose-document')(),'/existing/guide.markdown');assert.deepEqual(JSON.parse(JSON.stringify(dialogCalls[0])),{properties:['openFile'],filters:[{name:'Markdown documents',extensions:['md','markdown']}]});
 electron.dialog.showOpenDialog=async()=>({canceled:true,filePaths:[]});assert.equal(await handlers.get('choose-document')(),null);
 vm.runInNewContext(fs.readFileSync(new URL('../electron/preload.cjs',import.meta.url),'utf8'),{require:()=>({contextBridge:{exposeInMainWorld:(name,value)=>{exposed=value;}},ipcRenderer:{invoke:channel=>channel}})});assert.equal(exposed.chooseDocument(),'choose-document');
 assert.match(main,/existing\.api < 17/);assert.match(fs.readFileSync(new URL('../assets/start-canvas.sh',import.meta.url),'utf8'),/API_NEEDED=17/);
});
