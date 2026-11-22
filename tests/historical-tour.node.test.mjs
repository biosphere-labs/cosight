import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {AgentRunner} from '../assets/agent-runner.js';
import {library} from '../assets/library.js';
import {gitRequest} from '../assets/plugins/git.js';
import {createWorkspacePlugins} from '../assets/workspace-plugins.js';
import {readTour,projectDocument,writeTour,tourTools,readSource} from '../assets/tour-writer.js';
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const write=(root,name,text)=>fs.writeFileSync(path.join(root,name),text);
async function setup(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cosight-history-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const project=path.join(root,'project');fs.mkdirSync(project);git(project,'init','-b','main');git(project,'config','user.name','Tester');git(project,'config','user.email','tester@example.invalid');
  const commit=message=>{git(project,'add','.');git(project,'commit','-m',message);return git(project,'rev-parse','HEAD');};
  write(project,'shared.js','export const value = "initial";\n');write(project,'deleted.js','export const removed = true;\n');const initial=commit('initial');
  git(project,'checkout','-b','feature');write(project,'shared.js','export const value = "feature";\n');git(project,'rm','deleted.js');write(project,'binary.bin',Buffer.from([0,1]));const feature=commit('feature');
  git(project,'checkout','main');write(project,'shared.js','export const value = "main";\n');commit('main');write(project,'shared.js','export const value = "dirty live";\n');
  const comparison=await gitRequest(project,'comparison',{base:'main',head:'feature'});
  const data=path.join(root,'data');const fixture=path.join(root,'fake-agent.mjs');
  fs.writeFileSync(fixture,`
import fs from 'node:fs';import path from 'node:path';
import {Client} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/index.js'))};
import {StdioClientTransport} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/stdio.js'))};
const [runDir,sourceProject]=process.argv.slice(2),config=JSON.parse(fs.readFileSync(path.join(runDir,'run.json')));
const client=new Client({name:'historical-fixture',version:'1'});
try{
await client.connect(new StdioClientTransport({command:process.execPath,args:[${JSON.stringify(path.resolve('assets/agent-mcp.js'))},'cosight',path.join(runDir,'run.json')]}));
const tools=(await client.listTools()).tools;
const call=async(name,args={})=>client.callTool({name,arguments:args});
const context=await call('change_context'),after=await call('read_source',{path:'shared.js'}),before=await call('read_source',{path:'deleted.js',side:'before'}),escape=await call('read_source',{path:'../run.json'});
const custom=[];for(const tool of tools.filter(t=>t.name.startsWith('plugin_')))custom.push({name:tool.name,result:await call(tool.name,{path:'shared.js'})});
fs.writeFileSync(path.join(runDir,'fixture-receipt.json'),JSON.stringify({cwd:process.cwd(),sourceProject,tools,context,after,before,escape,custom}));
if(custom.length)for(let i=0;i<250&&!fs.existsSync(path.join(runDir,'release-fixture'));i++)await new Promise(resolve=>setTimeout(resolve,20));
if(config.kind==='question')await call('show',{file:'shared.js',start:1,end:1,say:'The pinned feature value remains.'});
else {await call('plan',{question:'Explain changes',stops:['Feature','Deleted']});await call('show',{file:'shared.js',start:1,end:1,stop:1,say:'This revision says feature.'});await call('show',{file:'deleted.js',side:'before',start:1,end:1,stop:2,say:'This prior file was deleted.'});}
}finally{await client.close();}
`);
  library(data).saveSettings(project,{agent:{provider:'custom',command:process.execPath,args:[fixture,'{runDir}','{project}']},serena:{enabled:true,command:'deliberately-unavailable-serena',args:[]},instructions:'Use clear explanations.'});
  return {root,data,project,initial,feature,comparison};
}
async function finish(runner){for(let i=0;i<200;i++){if(!runner.active)return;await new Promise(resolve=>setTimeout(resolve,30));}runner.cancel();throw Error('Fixture agent timed out');}
test('historical preparation exposes dependencies and cancellation aborts pending snapshots',async t=>{
  const {data,project,comparison}=await setup(t),runner=new AgentRunner(data);t.after(()=>runner.cancel());
  const head=git(project,'rev-parse','HEAD'),status=git(project,'status','--porcelain=v1');
  const pending=runner.start({project,text:'Explain',changeContext:{comparison,issues:[{id:'recorded-issue'}]}});
  assert.equal(runner.active,null);assert.equal(runner.startingProject,project);assert.deepEqual(runner.startingPlugins,['git','linear']);assert.equal(runner.starting,true);
  runner.cancel();await assert.rejects(pending,/cancel/i);
  assert.equal(runner.active,null);assert.equal(runner.starting,false);assert.equal(runner.startingProject,null);assert.deepEqual(runner.startingPlugins,[]);
  assert.equal(git(project,'rev-parse','HEAD'),head);assert.equal(git(project,'status','--porcelain=v1'),status);assert.equal(readTour(data),null);
});
test('runner executes pinned source with historical MCP, before deletions, provenance and offline content',async t=>{
  const {data,project,initial,feature,comparison}=await setup(t),runner=new AgentRunner(data);t.after(()=>runner.cancel());
  runner.pluginAccess=(chosen,options)=>{assert.equal(chosen,project);assert.deepEqual(options,{historical:true});return null;};
  const beforeHead=git(project,'rev-parse','HEAD'),beforeStatus=git(project,'status','--porcelain=v1');
  const issue={id:'issue-1',identifier:'DEMO-1',title:'Recorded intent',description:'Keep feature value',url:'https://linear.app/example/issue/DEMO-1',retrievedAt:new Date().toISOString()};
  const largeComparison={...comparison,patch:comparison.patch+'\n'+'x'.repeat(300000)};
  const started=await runner.start({project,text:'Explain the change',changeContext:{comparison:largeComparison,issues:[issue],warnings:['Ticket DEMO-2 was unavailable.']}});
  assert.deepEqual(runner.active.plugins,['git','linear']);await finish(runner);assert.equal(runner.last.error,'');
  const descriptor=JSON.parse(fs.readFileSync(path.join(started.runDir,'run.json'))),receipt=JSON.parse(fs.readFileSync(path.join(started.runDir,'fixture-receipt.json'))),doc=readTour(data);
  assert.equal(descriptor.project,project);assert.deepEqual(descriptor.plugins,['git','linear']);assert.equal(descriptor.serena.enabled,false);assert.equal(receipt.cwd,descriptor.sourceRoots.after);assert.equal(receipt.sourceProject,descriptor.sourceRoots.after);
  assert.equal(descriptor.pluginBridge,null);
  assert.deepEqual(receipt.tools.map(t=>t.name),['plan','show','change_context','read_source']);assert.equal(receipt.escape.isError,true);
  assert.equal(descriptor.changeContext.comparison.patch,largeComparison.patch);assert.deepEqual(JSON.parse(receipt.context.content[0].text).warnings,['Ticket DEMO-2 was unavailable.']);
  assert.match(JSON.parse(receipt.after.content[0].text).text,/feature/);assert.equal(JSON.parse(receipt.after.content[0].text).revision,feature);assert.equal(JSON.parse(receipt.before.content[0].text).revision,initial);assert.match(JSON.parse(receipt.before.content[0].text).text,/removed/);
  assert.ok(descriptor.changeContext.snapshots.after.omitted.includes('binary.bin: binary file'));
  assert.equal(doc.project,project);assert.equal(doc.source.after,feature);assert.equal(doc.stops[0].source.revision,feature);assert.equal(doc.stops[1].source.revision,initial);assert.equal(doc.stops[1].source.side,'before');assert.equal(doc.agentRun.serenaEnabled,false);
  assert.equal(git(project,'rev-parse','HEAD'),beforeHead);assert.equal(git(project,'status','--porcelain=v1'),beforeStatus);assert.match(fs.readFileSync(path.join(project,'shared.js'),'utf8'),/dirty live/);
  const prompt=fs.readFileSync(path.join(started.runDir,'prompt.txt'),'utf8');assert.ok(Buffer.byteLength(prompt)<24200);assert.ok(!prompt.includes('x'.repeat(1000)));assert.match(prompt,/Serena is explicitly disabled/);assert.match(prompt,/DEMO-1/);assert.match(prompt,/Distinguish recorded intent/);assert.match(prompt,/binary.bin: binary file/);assert.match(prompt,/Ticket DEMO-2 was unavailable/);
  // Subsequent questions retain the recorded comparison even if a caller supplies live refs.
  git(project,'branch','-f','feature','main');
  const follow=await runner.start({project,text:'Why feature?',kind:'question',step:1,changeContext:{comparison:{...comparison,head:beforeHead},issues:[]}});assert.deepEqual(runner.active.plugins,['git','linear']);await finish(runner);assert.equal(runner.last.error,'');
  const final=readTour(data);assert.equal(final.changeContext.comparison.head,feature);assert.equal(final.asides.length,1);assert.equal(final.asides[0].source.revision,feature);assert.equal(final.asides[0].ask,'Why feature?');
  fs.rmSync(started.runDir,{recursive:true});fs.rmSync(follow.runDir,{recursive:true});
  assert.match(fs.readFileSync(path.join(data,final.stops[0].fileUrl),'utf8'),/feature/);assert.match(fs.readFileSync(path.join(data,final.stops[1].fileUrl),'utf8'),/removed/);
  assert.ok(library(data).history(project).some(saved=>saved.tourId===final.tourId&&saved.changeContext.comparison.head===feature));
});
test('historical own tools use pinned source through host HTTP and MCP, reject stale runs and cancel on disable',async t=>{
  const {root,data,project,comparison}=await setup(t),runner=new AgentRunner(data);t.after(()=>runner.cancel());
  const host=await createWorkspacePlugins({root:data,runner,linearConnector:{status:async()=>({connected:false,state:'disconnected'}),close:async()=>{}}});t.after(()=>host.close());
  const entry=path.join(root,'own-tree.mjs');fs.writeFileSync(entry,`import fs from 'node:fs';import path from 'node:path';export async function execute(operation,input,context){return {operation,project:context.project,text:fs.readFileSync(path.join(context.project,'shared.js'),'utf8')};}`);
  for(const id of ['git','linear']){await host.request({project,plugin:id,operation:'install'});await host.request({project,plugin:id,operation:'enable'});}
  await host.request({project,plugin:'own-tree',operation:'install',input:{manifest:{id:'own-tree',api:1,version:'1.0.0',entry,capabilities:['Read-tree','inspect']}}});await host.request({project,plugin:'own-tree',operation:'enable'});
  const requests=[],server=createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    try{let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body);requests.push(input);res.end(JSON.stringify(await host.request(input)));}
    catch(error){res.statusCode=400;res.end(JSON.stringify({error:error.message}));}
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const endpoint=`http://127.0.0.1:${server.address().port}/plugins`;
  runner.pluginAccess=async(chosen,options)=>({endpoint,tools:await host.agentTools(chosen,options)});
  const beforeHead=git(project,'rev-parse','HEAD'),beforeStatus=git(project,'status','--porcelain=v1');
  const waitReceipt=async runDir=>{for(let i=0;i<200;i++){const file=path.join(runDir,'fixture-receipt.json');if(fs.existsSync(file))return JSON.parse(fs.readFileSync(file));if(!runner.active)throw Error('Agent exited before custom tool receipt: '+runner.last?.error);await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Timed out waiting for custom tools');};
  const started=await runner.start({project,text:'Use my tools to inspect the branch',changeContext:{comparison,issues:[]}}),receipt=await waitReceipt(started.runDir),descriptor=JSON.parse(fs.readFileSync(path.join(started.runDir,'run.json')));
  assert.deepEqual(runner.active.plugins,['git','own-tree']);assert.deepEqual(descriptor.plugins,['git','own-tree']);assert.equal(descriptor.pluginBridge.runId,started.runDir);
  assert.deepEqual(receipt.custom.map(c=>c.name),['plugin_own-tree__Read-tree','plugin_own-tree__inspect']);
  assert.ok(!receipt.tools.some(t=>/^plugin_(git|linear)__/.test(t.name)));
  for(const call of receipt.custom){assert.ok(!call.result.isError,JSON.stringify(call.result));const result=JSON.parse(call.result.content[0].text);assert.equal(result.project,descriptor.sourceRoots.after);assert.match(result.text,/"feature"/);assert.ok(!result.text.includes('dirty live'));}
  assert.ok(requests.every(request=>request.runId===started.runDir&&request.project===project));
  const gitTool=(await host.agentTools(project)).find(tool=>tool.name==='plugin_git__repository');
  const bypass=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project,plugin:'git',operation:'call',revision:gitTool.revision,runId:started.runDir,input:{operation:'repository'}})});
  assert.equal(bypass.status,400);assert.match((await bypass.json()).error,/pinned Git/);
  fs.writeFileSync(path.join(started.runDir,'release-fixture'),'');await finish(runner);assert.equal(runner.last.error,'');
  const customTool=descriptor.pluginBridge.tools[0],stale=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project,plugin:customTool.plugin,operation:'call',revision:customTool.revision,runId:started.runDir,input:{operation:customTool.operation}})});
  assert.equal(stale.status,400);assert.match((await stale.json()).error,/no longer active/);
  const second=await runner.start({project,text:'Inspect again',changeContext:{comparison,issues:[]}});await waitReceipt(second.runDir);assert.ok(runner.active.plugins.includes('own-tree'));
  await host.request({project,plugin:'own-tree',operation:'disable'});assert.equal(runner.active,null);assert.match(runner.last.error,/stopped/i);
  assert.equal((await host.agentTools(project,{historical:true})).length,0);assert.equal(git(project,'rev-parse','HEAD'),beforeHead);assert.equal(git(project,'status','--porcelain=v1'),beforeStatus);assert.match(fs.readFileSync(path.join(project,'shared.js'),'utf8'),/dirty live/);
});
test('standalone plugin bridge advertises domain tools and preserves host revision checks',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cosight-plugin-mcp-')),project=path.join(root,'project');fs.mkdirSync(project);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const tool={name:'plugin_git__repository',plugin:'git',operation:'repository',revision:7,description:'Read repository',inputSchema:{type:'object',properties:{},additionalProperties:true},annotations:{readOnlyHint:true}};
  let enabled=true,received;
  const server=createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.method==='GET'){assert.match(req.url,/^\/plugins\/tools\?project=/);res.end(JSON.stringify({tools:[tool]}));return;}
    let body='';for await(const chunk of req)body+=chunk;received=JSON.parse(body);
    if(!enabled){res.statusCode=400;res.end(JSON.stringify({error:'Plugin registration was replaced'}));return;}
    res.end(JSON.stringify({root:project,head:'pinned-by-host'}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const endpoint=`http://127.0.0.1:${server.address().port}/plugins`,client=new Client({name:'bridge-test',version:'1'});t.after(()=>client.close());
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('assets/agent-mcp.js'),'standalone','--project',project,'--data-dir',path.join(root,'data'),'--plugin-url',endpoint]}));
  const advertised=(await client.listTools()).tools.find(t=>t.name===tool.name);assert.equal(advertised.plugin,undefined);assert.equal(advertised.revision,undefined);assert.equal(advertised.annotations.readOnlyHint,true);
  const result=await client.callTool({name:tool.name,arguments:{operation:'source'}});assert.equal(result.isError,undefined);assert.equal(JSON.parse(result.content[0].text).head,'pinned-by-host');
  assert.equal(received.plugin,'git');assert.equal(received.operation,'call');assert.equal(received.input.operation,'repository');assert.equal(received.revision,7);assert.equal(received.project,fs.realpathSync(project));
  enabled=false;const denied=await client.callTool({name:tool.name,arguments:{}});assert.equal(denied.isError,true);assert.match(denied.content[0].text,/replaced/);
  const invalid=new Client({name:'invalid-bridge',version:'1'});t.after(()=>invalid.close());
  await assert.rejects(invalid.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('assets/agent-mcp.js'),'standalone','--project',project,'--data-dir',path.join(root,'invalid'),'--plugin-url','https://example.com/plugins'],stderr:'pipe'})));
});
test('Stop, finish and caller cancellation terminate custom workers while leaving the plugin usable',async t=>{
  const {root,data,project,comparison}=await setup(t),runner=new AgentRunner(data);t.after(()=>runner.cancel());
  const host=await createWorkspacePlugins({root:data,runner,linearConnector:{status:async()=>({connected:false,state:'disconnected'}),close:async()=>{}}});t.after(()=>host.close());
  const entry=path.join(root,'delayed-tool.mjs');fs.writeFileSync(entry,`import fs from 'node:fs';export async function execute(operation,input,context){fs.writeFileSync(input.marker+'.started',JSON.stringify({project:context.project}));await new Promise(resolve=>setTimeout(resolve,input.delay??700));fs.writeFileSync(input.marker+'.finished','finished');return {project:context.project,finished:true};}`);
  await host.request({project,plugin:'delayed-tool',operation:'install',input:{manifest:{id:'delayed-tool',api:1,version:'1.0.0',entry,capabilities:['wait']}}});await host.request({project,plugin:'delayed-tool',operation:'enable'});
  const outcomes=[],server=createServer(async(req,res)=>{
    const controller=new AbortController();res.on('close',()=>{if(!res.writableEnded)controller.abort();});res.setHeader('content-type','application/json');
    try{let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body);const result=await host.request(input,{signal:controller.signal});outcomes.push({runId:input.runId,ok:true});res.end(JSON.stringify(result));}
    catch(error){outcomes.push({error:error.message});res.statusCode=400;res.end(JSON.stringify({error:error.message}));}
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const endpoint=`http://127.0.0.1:${server.address().port}/plugins`;runner.pluginAccess=async(chosen,options)=>({endpoint,tools:await host.agentTools(chosen,options)});
  const fixture=path.join(root,'waiting-agent.mjs');fs.writeFileSync(fixture,`
import fs from 'node:fs';import path from 'node:path';
import {Client} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/index.js'))};
import {StdioClientTransport} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/stdio.js'))};
const runDir=process.argv[2],client=new Client({name:'waiting-agent',version:'1'});
try{await client.connect(new StdioClientTransport({command:process.execPath,args:[${JSON.stringify(path.resolve('assets/agent-mcp.js'))},'cosight',path.join(runDir,'run.json')]}));const tool=(await client.listTools()).tools.find(t=>t.name==='plugin_delayed-tool__wait');const result=await client.callTool({name:tool.name,arguments:{marker:path.join(runDir,'tool'),delay:700}});fs.writeFileSync(path.join(runDir,'settled.json'),JSON.stringify(result));}finally{await client.close();}
`);
  library(data).saveSettings(project,{agent:{provider:'custom',command:process.execPath,args:[fixture,'{runDir}']},serena:{enabled:false,command:'unused',args:[]},instructions:''});
  const waitFor=async predicate=>{for(let i=0;i<250;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Timed out waiting for cancellation fixture');};
  for(const historical of [false,true]){
    const started=await runner.start({project,text:'Wait for my custom tool',...(historical?{changeContext:{comparison,issues:[]}}:{})}),marker=path.join(started.runDir,'tool');
    const descriptor=JSON.parse(fs.readFileSync(path.join(started.runDir,'run.json')));assert.equal(descriptor.pluginBridge.runId,started.runDir);assert.ok(runner.active.plugins.includes('delayed-tool'));
    await waitFor(()=>fs.existsSync(marker+'.started'));const startedEvidence=JSON.parse(fs.readFileSync(marker+'.started'));assert.equal(startedEvidence.project,historical?descriptor.sourceRoots.after:project);
    const run=runner.active;if(historical)runner.finish(run,'Fixture finish');else runner.cancel();assert.equal(runner.active,null);assert.equal(run.controller.signal.aborted,true);
    await waitFor(()=>outcomes.some(item=>item.error));await new Promise(resolve=>setTimeout(resolve,850));assert.equal(fs.existsSync(marker+'.finished'),false,'cancelled worker must not reach delayed side effect');
    assert.ok(outcomes.some(item=>/cancel|abort/i.test(item.error||'')),JSON.stringify(outcomes));
    if(historical){assert.equal(JSON.parse(fs.readFileSync(path.join(started.runDir,'settled.json'))).isError,true);}
    const nextMarker=path.join(root,historical?'manual-after-finish':'manual-after-stop');const next=await host.request({project,plugin:'delayed-tool',operation:'call',input:{operation:'wait',marker:nextMarker,delay:0}});assert.equal(next.finished,true);assert.equal(fs.readFileSync(nextMarker+'.finished','utf8'),'finished');assert.equal((await host.status(project)).plugins.find(p=>p.id==='delayed-tool').enabled,true);
    outcomes.length=0;
  }
  const marker=path.join(root,'caller-abort'),controller=new AbortController();
  const pending=host.request({project,plugin:'delayed-tool',operation:'call',input:{operation:'wait',marker,delay:700}},{signal:controller.signal});
  const observed=pending.then(result=>({result}),error=>({error}));await waitFor(()=>fs.existsSync(marker+'.started'));controller.abort();const result=await observed;assert.match(result.error?.message||'',/cancel|abort/i);
  await new Promise(resolve=>setTimeout(resolve,850));assert.equal(fs.existsSync(marker+'.finished'),false);
  const lastMarker=path.join(root,'manual-after-caller');assert.equal((await host.request({project,plugin:'delayed-tool',operation:'call',input:{operation:'wait',marker:lastMarker,delay:0}})).finished,true);assert.equal(fs.existsSync(lastMarker+'.finished'),true);
});
test('source tools reject traversal and escaping symlinks and legacy tours keep live source',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cosight-historical-writer-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const project=path.join(root,'project');fs.mkdirSync(project);write(project,'live.js','live');write(root,'secret','secret');fs.symlinkSync(path.join(root,'secret'),path.join(project,'escape'));
  for(const name of ['../secret','/etc/passwd','a/../live.js','a\\b','C:/secret','escape'])assert.throws(()=>readSource({project},{path:name}));
  assert.throws(()=>readSource({project},{path:'live.js',side:'before'}),/before source/);assert.throws(()=>readSource({project},{path:'live.js',side:'unknown'}),/side/);
  writeTour(root,{...projectDocument(project),tourId:'legacy'});const writer=tourTools({root,project,tourId:'legacy'});writer.plan({question:'Live?',stops:['Live']});writer.show({file:path.join(project,'live.js'),start:1,end:1,stop:1,say:'Live source.'});assert.equal(readTour(root).stops[0].source,undefined);assert.equal(readSource({project},{path:'live.js'}).text,'live');
  assert.throws(()=>readSource({project,ephemeralSourcePaths:{after:['live.js']}},{path:'live.js'}),/not pinned Git source/);
});
