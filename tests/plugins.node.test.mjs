import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createPluginHost,analysisResults} from '../assets/plugin-host.js';
import {runProcess} from '../assets/plugins/process.js';

function fixture(t){
  fs.mkdirSync('temp',{recursive:true});const root=fs.mkdtempSync(path.resolve('temp/plugins-test-'));
  const project=path.join(root,'source'),other=path.join(root,'other');fs.mkdirSync(project);fs.mkdirSync(other);
  fs.writeFileSync(path.join(project,'a.js'),'import { b } from "./b.js";\nexport function a() { console.log(b()); }\n');
  fs.writeFileSync(path.join(project,'b.js'),'import { a } from "./a.js";\nexport function b() { return a; }\n');
  fs.writeFileSync(path.join(project,'example.py'),'def greet(name):\n    print(name)\n');
  fs.writeFileSync(path.join(other,'outside.js'),'console.log("outside")');
  fs.symlinkSync(other,path.join(project,'linked'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,project,other};
}
async function finish(host,project,id){
  for(let n=0;n<200;n++){
    const state=await host.status(project),result=state.results.find(r=>r.id===id);
    if(result)return result;
    await new Promise(r=>setTimeout(r,25));
  }
  throw Error('Analysis did not finish');
}
test('real analyzers work across JS and Python in a folder without Git; results and configuration survive restart',async t=>{
  const {root,project,other}=fixture(t);let host=await createPluginHost({root});t.after(()=>host.close());
  for(const [language,pattern,file,line] of [['JavaScript','console.log($$$ARGS)','a.js',2],['Python','print($$$ARGS)','example.py',2]]){
    const {id}=await host.run({project,plugin:'patterns',tool:'search',input:{language,pattern}});
    const record=await finish(host,project,id);assert.equal(record.state,'done',record.error);
    assert.equal(record.result.findings.length,1);assert.equal(record.result.findings[0].file,file);assert.equal(record.result.findings[0].line,line);
  }
  const {id}=await host.run({project,plugin:'dependencies',tool:'graph'});
  const record=await finish(host,project,id);assert.equal(record.state,'done',record.error);
  assert.ok(record.result.graph.edges.some(e=>e.from==='a.js'&&e.to==='b.js'));
  assert.ok(record.result.graph.edges.some(e=>e.from==='b.js'&&e.to==='a.js'));
  assert.ok(record.result.findings.some(f=>f.kind==='cycle'));
  await host.configure({project,plugin:'dependencies',enabled:false});
  let status=await host.status(project);assert.ok(!status.tools.some(t=>t.owner==='dependencies'));assert.ok(!status.views.some(v=>v.owner==='dependencies'));
  await assert.rejects(host.run({project,plugin:'dependencies',tool:'graph'}),/Enable/);
  assert.ok((await host.status(other)).tools.some(t=>t.owner==='dependencies'));
  await host.close();host=await createPluginHost({root});
  status=await host.status(project);assert.equal(status.results.length,3);assert.equal(status.plugins.find(p=>p.id==='dependencies').enabled,false);
  assert.equal(analysisResults(root,project).length,3);
  assert.equal(fs.existsSync(path.join(project,'.git')),false);
});
test('disabling an active plugin cancels work and withdraws tools and views without removing another plugin',async t=>{
  const {root,project}=fixture(t);
  const catalog=[{id:'slow',title:'Slow fixture',bundled:true,languages:['fixture'],view:{id:'slow',title:'Slow'},tools:[{id:'wait',inputSchema:{properties:{}},execute:(_,job)=>runProcess(process.execPath,['-e','setInterval(()=>{},1000)'],job)}]}];
  const host=await createPluginHost({root,catalog});t.after(()=>host.close());
  const {id}=await host.run({project,plugin:'slow',tool:'wait'});
  await new Promise(r=>setTimeout(r,80));await host.configure({project,plugin:'slow',enabled:false});
  const state=await host.status(project);assert.equal(state.tools.length,0);assert.equal(state.views.length,0);assert.equal(state.running.length,0);
  assert.equal(state.results.find(r=>r.id===id).state,'cancelled');
});
test('external adapters report unavailable tools instead of pretending to analyze',async t=>{
  const {root,project}=fixture(t),host=await createPluginHost({root});t.after(()=>host.close());
  await host.configure({project,plugin:'joern',enabled:true,command:path.join(root,'missing-joern')});
  assert.equal((await host.status(project)).plugins.find(p=>p.id==='joern').state,'needs-install');
  await assert.rejects(host.run({project,plugin:'joern',tool:'calls'}),/Install Joern/);
});
test('cancellation retires nested analyzer subprocesses in the worker process group',async t=>{
  if(process.platform==='win32')return t.skip('POSIX process-group ownership');
  const {root}=fixture(t),pidFile=path.join(root,'nested.pid'),controller=new AbortController();
  const code=`const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000)`;
  const task=runProcess(process.execPath,['-e',code],{signal:controller.signal});
  let pid;
  for(let n=0;n<100;n++){if(fs.existsSync(pidFile)){pid=Number(fs.readFileSync(pidFile,'utf8'));break;}await new Promise(r=>setTimeout(r,10));}
  assert.ok(pid);controller.abort();await assert.rejects(task,/cancelled/);
  for(let n=0;n<100;n++){try{process.kill(pid,0);}catch{return;}await new Promise(r=>setTimeout(r,10));}
  assert.fail('Nested analyzer is still running after cancellation');
});
