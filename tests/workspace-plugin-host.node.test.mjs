import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,access,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {createWorkspacePlugins} from '../assets/workspace-plugins.js';
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1'}}).trim();
const baseSource='export const answer = 1;\n',headSource='export const answer = 2;\n';
async function setup(t){
 const folder=await realpath(await mkdtemp(path.join(os.tmpdir(),'cosight-workspace-host-'))),root=path.join(folder,'appdata'),project=path.join(folder,'repo'),other=path.join(folder,'other');await mkdir(project);await mkdir(other);await mkdir(root);
 git(project,'init','--quiet','-b','main');git(project,'config','user.email','fixture@example.test');git(project,'config','user.name','Fixture');await writeFile(path.join(project,'feature.js'),baseSource);git(project,'add','.');git(project,'commit','--quiet','-m','Base source');const base=git(project,'rev-parse','HEAD');git(project,'checkout','--quiet','-b','feature');await writeFile(path.join(project,'feature.js'),headSource);git(project,'commit','--quiet','-am','Feature source');const head=git(project,'rev-parse','HEAD');
 const linearCalls=[];const linearConnector={async status(){return {connected:true,state:'fixture',workspace:{id:'workspace-1',name:'Fixture workspace'}};},async begin(){return {url:'https://example.test/fixture',state:'fixture'};},async finish(){return this.status();},async disconnect(){},async close(){},async request(operation,input,context){linearCalls.push({operation,input,context});if(operation==='issue')return {id:input.id,identifier:'EX-123',title:'Recorded intent',description:'Ticket evidence fixture',url:'https://linear.app/example-workspace/issue/EX-123',retrievedAt:'2026-11-01T00:00:00.000Z'};if(operation==='discussion')return {items:[{id:'comment-1',body:'Recorded decision fixture'}],nextCursor:null};return {items:[{id:'project-1',name:'Fixture project'}],nextCursor:null};}};
 const runner={active:null,started:[],cancellations:0,async start(input){this.started.push(input);this.active={project:input.project,plugins:['git',...(input.changeContext?.issues?.length?['linear']:[])]};return {id:'fixture-agent',kind:input.kind};},cancel(){this.cancellations++;this.active=null;}};
 let host=await createWorkspacePlugins({root,runner,linearConnector});t.after(async()=>{await host.close();await rm(folder,{recursive:true,force:true});});
 const request=(operation,plugin,input={},selected=project)=>host.request({project:selected,plugin,operation,input});const call=(plugin,operation,input={},selected=project)=>request('call',plugin,{operation,...input},selected);
 return {folder,root,project,other,base,head,linearCalls,linearConnector,runner,request,call,get host(){return host;},async restart(){await host.close();host=await createWorkspacePlugins({root,runner,linearConnector});return host;}};
}
async function enable(f,id,project=f.project){await f.request('install',id,{},project);await f.request('enable',id,{},project);}
const plugin=(status,id)=>status.plugins.find(x=>x.id===id);
test('branch issue associations include only matching or project-wide intent in actions',async t=>{
 const f=await setup(t);await enable(f,'git');await enable(f,'linear');
 await f.request('associate','linear',{issues:[{id:'i1',identifier:'DEMO-1',branch:'refs/heads/feature'},{id:'i2',identifier:'DEMO-2',branch:'other-feature'},{id:'i3',identifier:'DEMO-3',branch:null}]});
 await f.request('action','git',{action:'tour',base:'main',head:'feature'});
 assert.deepEqual(f.runner.started[0].changeContext.issues.map(x=>x.id),['i1','i3']);
 assert.equal((await f.host.status(f.project)).associations.issues[1].branch,'other-feature');
});
test('historical ticket context preserves discussion pagination as an explicit limitation',async t=>{
 const f=await setup(t);await enable(f,'git');await enable(f,'linear');
 const request=f.linearConnector.request;f.linearConnector.request=async(...args)=>args[0]==='discussion'?{items:[{body:'First page'}],nextCursor:'remaining-comments'}:request(...args);
 await f.request('associate','linear',{issues:[{id:'i1',identifier:'DEMO-1'}]});await f.request('action','git',{action:'explain',base:'main',head:'feature'});
 const context=f.runner.started[0].changeContext;assert.equal(context.issues[0].discussion.nextCursor,'remaining-comments');assert.equal(context.issues[0].discussion.truncated,true);assert.match(context.warnings.join(' '),/first discussion page/);
});
async function custom(f,{version='1.0.0',source='export async function execute(operation,input,context){ return {version:"one",operation,input,project:context.project}; }',id='local-reader'}={}){const entry=path.join(f.folder,id+'-'+version+'.mjs');await writeFile(entry,source);return {id,version,api:1,title:'Local reader',description:'Self-contained test module',capabilities:['read'],entry};}
async function waitFile(file){for(let i=0;i<200;i++){try{return await readFile(file,'utf8');}catch{}await new Promise(r=>setTimeout(r,5));}throw Error('Timed out waiting for '+file);}

test('catalog availability, independent plugin lifecycle and per-project enablement persist across restart',async t=>{
 const f=await setup(t);let status=await f.host.status(f.project);assert.equal(plugin(status,'git').state,'available');assert.equal(plugin(status,'linear').installed,false);
 await f.request('install','git');await f.request('enable','git');await f.request('install','linear');await f.request('enable','linear');
 status=await f.host.status(f.other);assert.equal(plugin(status,'git').installed,true);assert.equal(plugin(status,'git').enabled,false);assert.equal(plugin(status,'linear').enabled,false);
 await f.request('enable','linear',{},f.other);await f.request('disable','git');status=await f.host.status(f.project);assert.equal(plugin(status,'git').enabled,false);assert.equal(plugin(status,'linear').enabled,true);assert.ok(status.views.some(v=>v.owner==='linear'));assert.ok(!status.views.some(v=>v.owner==='git'));
 await f.restart();assert.equal(plugin(await f.host.status(f.project),'linear').enabled,true);assert.equal(plugin(await f.host.status(f.other),'linear').enabled,true);
 await f.request('remove','git');status=await f.host.status(f.project);assert.equal(plugin(status,'git').installed,false);assert.equal(plugin(status,'linear').enabled,true);assert.equal(plugin(await f.host.status(f.other),'git').installed,false);
 await assert.rejects(f.call('git','repository'),/enable|install/i);
});
test('global installation is separate from project settings; real graph and source reads preserve worktree',async t=>{
 const f=await setup(t);const before=git(f.project,'status','--porcelain=v1','--untracked-files=all');await enable(f,'git');
 const repo=await f.call('git','repository');assert.equal(repo.head,f.head);assert.ok(repo.refs.some(r=>r.name==='refs/heads/feature'));
 const history=await f.call('git','history',{revision:f.head});assert.deepEqual(history.commits.map(c=>c.sha),[f.head,f.base]);
 const comparison=await f.call('git','comparison',{base:f.base,head:f.head});assert.equal(comparison.base,f.base);assert.equal(comparison.head,f.head);assert.ok(comparison.patch.includes('+export const answer = 2;'));
 assert.equal((await f.call('git','source',{revision:f.base,path:'feature.js'})).text,baseSource);assert.equal((await f.call('git','source',{revision:f.head,path:'feature.js'})).text,headSource);
 assert.equal(git(f.project,'status','--porcelain=v1','--untracked-files=all'),before);assert.ok((await readFile(path.join(f.root,'plugins/installed.json'),'utf8')).includes('git'));await assert.rejects(access(path.join(f.project,'.cosight')));
});
test('Linear fixture connector calls and associations persist independently per project',async t=>{
 const f=await setup(t);await enable(f,'linear');await f.request('enable','linear',{},f.other);
 await f.request('associate','linear',{workspace:{id:'w',name:'Workspace'},project:{id:'p',name:'CoSight'},issues:[{id:'i',identifier:'EX-123',title:'Intent',url:'https://linear.app/example-workspace/issue/EX-123'}]});
 assert.equal((await f.host.status(f.other)).associations.issues.length,0);await f.call('linear','issues',{projectId:'p'});assert.equal(f.linearCalls.at(-1).input.project,'p');
 await f.request('disable','linear');await f.restart();let association=(await f.host.status(f.project)).associations;assert.equal(association.issues[0].identifier,'EX-123');assert.equal(association.project.id,'p');await f.request('remove','linear');association=(await f.host.status(f.project)).associations;assert.equal(association.workspace.id,'w');assert.equal(association.issues.length,1);
});
test('self-contained local ESM package executes copied code; version replacement preserves enabled projects',async t=>{
 const f=await setup(t),manifest=await custom(f);await f.request('install',manifest.id,{manifest});await f.request('enable',manifest.id);await f.request('enable',manifest.id,{},f.other);
 await writeFile(manifest.entry,'throw Error("source moved after installation");');assert.equal((await f.call(manifest.id,'read',{value:1})).version,'one');
 const next=await custom(f,{version:'2.0.0',source:'export async function execute(){return {version:"two"};}'});await f.request('replace',next.id,{manifest:next});assert.equal((await f.call(next.id,'read')).version,'two');assert.equal((await f.call(next.id,'read',{},f.other)).version,'two');
 await f.restart();assert.equal(plugin(await f.host.status(f.project),next.id).version,'2.0.0');assert.equal((await f.call(next.id,'read')).version,'two');
});
test('invalid manifest or invalid source replacement retains prior working implementation and other plugins',async t=>{
 const f=await setup(t);await enable(f,'git');const manifest=await custom(f);await f.request('install',manifest.id,{manifest});await f.request('enable',manifest.id);
 await assert.rejects(f.request('replace',manifest.id,{manifest:{...manifest,api:999}}),/API/);assert.equal((await f.call(manifest.id,'read')).version,'one');
 const broken=await custom(f,{version:'2.0.0',source:'export const noExecute = true;'});await assert.rejects(f.request('replace',broken.id,{manifest:broken}),/execute/);assert.equal((await f.call(manifest.id,'read')).version,'one');assert.equal(plugin(await f.host.status(f.project),'git').enabled,true);assert.equal((await f.call('git','repository')).head,f.head);
});
for(const mutation of ['disable','remove','replace'])test(mutation+' cancels owned invocation and keeps unrelated plugin usable',async t=>{
 const f=await setup(t);await enable(f,'git');const marker=path.join(f.folder,'pending-'+mutation);
 const manifest=await custom(f,{source:'import fs from "node:fs"; export async function execute(op,input,{signal}){fs.writeFileSync(input.marker,"started");return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("fixture watchdog: no cancellation")),3000);signal.addEventListener("abort",()=>{clearTimeout(timer);fs.writeFileSync(input.marker+".aborted","aborted");reject(Error("fixture cancelled"));},{once:true});});}'});
 await f.request('install',manifest.id,{manifest});await f.request('enable',manifest.id);const work=f.call(manifest.id,'read',{marker});const rejected=assert.rejects(work,/cancelled/);await waitFile(marker);
 const next=mutation==='replace'?await custom(f,{version:'2.0.0',source:'export async function execute(){return "replacement";}'}):null;
 await f.request(mutation,manifest.id,next?{manifest:next}:{});await rejected;assert.equal(await waitFile(marker+'.aborted'),'aborted');assert.equal((await f.call('git','repository')).head,f.head);if(next)assert.equal(await f.call(next.id,'read'),'replacement');
});
test('disabling a non-cooperative local tool terminates its process without freezing the host',async t=>{
 const f=await setup(t);await enable(f,'git');const marker=path.join(f.folder,'non-cooperative.pid');
 const manifest=await custom(f,{source:'import fs from "node:fs"; export async function execute(op,input){fs.writeFileSync(input.marker,String(process.pid));while(true){}}'});
 await f.request('install',manifest.id,{manifest});await f.request('enable',manifest.id);const work=f.call(manifest.id,'read',{marker});const rejected=assert.rejects(work,/cancelled/);const pid=Number(await waitFile(marker));
 await f.request('disable',manifest.id);await rejected;
 let alive=true;for(let i=0;i<100;i++){try{process.kill(pid,0);}catch{alive=false;break;}await new Promise(r=>setTimeout(r,5));}
 assert.equal(alive,false);assert.equal((await f.call('git','repository')).head,f.head);
});
test('action runner fixture receives real comparison plus ticket evidence/discussion; owning disable cancels it',async t=>{
 const f=await setup(t);await enable(f,'git');await enable(f,'linear');await f.request('associate','linear',{issues:[{id:'issue-1',identifier:'EX-123',title:'Intent',url:'https://linear.app/example-workspace/issue/EX-123'}]});
 const result=await f.request('action',null,{action:'explain',base:f.base,head:f.head});assert.equal(result.id,'fixture-agent');const request=f.runner.started.at(-1);assert.equal(request.project,f.project);assert.equal(request.changeContext.comparison.base,f.base);assert.equal(request.changeContext.comparison.head,f.head);assert.ok(request.changeContext.comparison.patch.includes('+export const answer = 2;'));assert.equal(request.changeContext.issues[0].description,'Ticket evidence fixture');assert.equal(request.changeContext.issues[0].comments[0].body,'Recorded decision fixture');assert.equal(f.runner.cancellations,0);
 await f.request('disable','linear');assert.equal(f.runner.cancellations,1);assert.equal(plugin(await f.host.status(f.project),'git').enabled,true);
 await f.request('action',null,{action:'tour',base:f.base,head:f.head});await f.request('disable','git');assert.equal(f.runner.cancellations,2);
});

test('per-project disable does not cancel a runner owned by a different project',async t=>{
 const f=await setup(t);await enable(f,'git');await f.request('enable','git',{},f.other);await f.request('action',null,{action:'tour',base:f.base,head:f.head});
 assert.equal(f.runner.active.project,f.project);await f.request('disable','git',{},f.other);assert.equal(f.runner.cancellations,0);assert.equal(plugin(await f.host.status(f.project),'git').enabled,true);
});

test('agent tools expose only enabled capabilities with revision and first-party read-only metadata',async t=>{
 const f=await setup(t);assert.deepEqual(await f.host.agentTools(f.project),[]);await f.request('install','git');assert.deepEqual(await f.host.agentTools(f.project),[]);await f.request('enable','git');
 const tools=await f.host.agentTools(f.project),state=await f.host.status(f.project);assert.deepEqual(tools.map(x=>x.operation).sort(),['comparison','history','repository','source']);
 for(const tool of tools){assert.equal(tool.plugin,'git');assert.equal(tool.name,'plugin_git__'+tool.operation);assert.equal(tool.revision,plugin(state,'git').revision);assert.equal(tool.annotations.readOnlyHint,true);assert.equal(tool.annotations.destructiveHint,false);assert.equal(tool.inputSchema.type,'object');}
 const tool=tools.find(x=>x.operation==='repository');const result=await f.host.request({project:f.project,plugin:tool.plugin,operation:'call',revision:tool.revision,input:{operation:tool.operation}});assert.equal(result.head,f.head);
 assert.deepEqual(await f.host.agentTools(f.other),[]);await f.request('disable','git');assert.deepEqual(await f.host.agentTools(f.project),[]);await assert.rejects(f.host.request({project:f.project,plugin:tool.plugin,operation:'call',revision:tool.revision,input:{operation:tool.operation}}),/enable|install/i);
});

test('disable and re-enable rejects stale revision while keeping unrelated plugin and project revisions valid',async t=>{
 const f=await setup(t);await enable(f,'git');await enable(f,'linear');await f.request('enable','git',{},f.other);
 const original=(await f.host.agentTools(f.project)).find(x=>x.name==='plugin_git__repository');const other=(await f.host.agentTools(f.other)).find(x=>x.name==='plugin_git__repository');const linear=(await f.host.agentTools(f.project)).find(x=>x.name==='plugin_linear__projects');
 await f.request('disable','git');await f.request('enable','git');const fresh=(await f.host.agentTools(f.project)).find(x=>x.name===original.name);assert.notEqual(fresh.revision,original.revision);
 await assert.rejects(f.host.request({project:f.project,plugin:'git',operation:'call',revision:original.revision,input:{operation:'repository'}}),/capabilities changed|fresh agent/i);
 assert.equal((await f.host.request({project:f.project,plugin:'git',operation:'call',revision:fresh.revision,input:{operation:'repository'}})).head,f.head);
 assert.equal((await f.host.agentTools(f.other)).find(x=>x.name===other.name).revision,other.revision);assert.equal((await f.host.agentTools(f.project)).find(x=>x.name===linear.name).revision,linear.revision);
 const projects=await f.host.request({project:f.project,plugin:'linear',operation:'call',revision:linear.revision,input:{operation:'projects'}});assert.equal(projects.items[0].id,'project-1');
});

test('package replacement and host restart invalidate captured capabilities while fresh descriptors execute current code',async t=>{
 const f=await setup(t);const first=await custom(f);await f.request('install',first.id,{manifest:first});await f.request('enable',first.id);await f.request('enable',first.id,{},f.other);
 const before=(await f.host.agentTools(f.project)).find(x=>x.plugin===first.id),otherBefore=(await f.host.agentTools(f.other)).find(x=>x.plugin===first.id);
 const invoke=(descriptor,project=f.project)=>f.host.request({project,plugin:descriptor.plugin,operation:'call',revision:descriptor.revision,input:{operation:descriptor.operation}});
 assert.equal((await invoke(before)).version,'one');const next=await custom(f,{version:'2.0.0',source:'export async function execute(){return {version:"two"};}'});await f.request('replace',first.id,{manifest:next});
 await assert.rejects(invoke(before),/capabilities changed|fresh agent/i);await assert.rejects(invoke(otherBefore,f.other),/capabilities changed|fresh agent/i);
 const replaced=(await f.host.agentTools(f.project)).find(x=>x.plugin===first.id);assert.notEqual(replaced.revision,before.revision);assert.equal((await invoke(replaced)).version,'two');
 await f.restart();await assert.rejects(invoke(replaced),/capabilities changed|fresh agent/i);const restarted=(await f.host.agentTools(f.project)).find(x=>x.plugin===first.id);assert.notEqual(restarted.revision,replaced.revision);assert.equal((await invoke(restarted)).version,'two');
});
