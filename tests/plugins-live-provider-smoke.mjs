// Explicit subscription-only provider verification. No fake CLI, Linear consent, or API fallback.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync,execFileSync} from 'node:child_process';
import {binary,cleanEnvironment,defaultSerena} from '../assets/agent-config.js';
import {library} from '../assets/library.js';
import {AgentRunner} from '../assets/agent-runner.js';
import {readTour} from '../assets/tour-writer.js';
import {createWorkspacePlugins} from '../assets/workspace-plugins.js';
const timestamp=new Date().toISOString(),suffix=timestamp.replace(/[:.]/g,'-');
const folder=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cosight-live-provider-'))),root=path.join(folder,'appdata'),project=path.join(folder,'repo');
const receiptFile=path.resolve('artifacts/verification/plugin-live-provider-'+suffix+'.json');
const receipt={at:timestamp,provider:'codex',authentication:'ChatGPT subscription only',fixture:'small real Git repository; no fixture provider or Linear data',folder,root,project,passed:false};
const command=binary('codex'),runner=new AgentRunner(root);let host;
const git=(...args)=>execFileSync('git',args,{cwd:project,encoding:'utf8'}).trim();
const sources={before:'export function normalize(value) {\n  return value;\n}\n\nexport function total(values) {\n  return values.reduce((sum, value) => sum + normalize(value), 0);\n}\n',after:'export function normalize(value) {\n  return Math.max(0, value);\n}\n\nexport function total(values) {\n  return values.reduce((sum, value) => sum + normalize(value), 0);\n}\n'};
const jsonLines=file=>fs.readFileSync(file,'utf8').split('\n').filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
try{
 const login=spawnSync(command,['login','status'],{env:cleanEnvironment(),encoding:'utf8',timeout:15000});
 receipt.login={command,exitCode:login.status,subscriptionConfirmed:login.status===0&&/ChatGPT/i.test((login.stdout||'')+(login.stderr||''))};
 assert.ok(receipt.login.subscriptionConfirmed,'Codex ChatGPT subscription login unavailable; no metered fallback');
 fs.mkdirSync(project,{recursive:true});git('init','--quiet','-b','main');git('config','user.name','CoSight live fixture');git('config','user.email','fixture@example.test');
 fs.writeFileSync(path.join(project,'math.js'),sources.before);git('add','.');git('commit','--quiet','-m','Base normalize');const base=git('rev-parse','HEAD');git('checkout','--quiet','-b','feature');fs.writeFileSync(path.join(project,'math.js'),sources.after);git('commit','--quiet','-am','Clamp negative input');const head=git('rev-parse','HEAD');
 git('checkout','--quiet','main');fs.writeFileSync(path.join(project,'main-only.js'),'export const mainOnly = true;\n');git('add','.');git('commit','--quiet','-m','Divergent main');const originalHead=git('rev-parse','HEAD');const dirty='// Dirty live source: must never appear in pinned tour\nexport const dirtySentinel = "LIVE_UNCOMMITTED";\n';fs.writeFileSync(path.join(project,'math.js'),dirty);fs.writeFileSync(path.join(project,'untracked.txt'),'original untracked bytes\n');const originalStatus=git('status','--porcelain=v1','--untracked-files=all');
 receipt.git={base,head,originalHead,originalStatus};
 library(root).saveSettings(project,{agent:{provider:'codex',command},serena:{...defaultSerena,enabled:false},instructions:'Use exactly two brief stops in math.js. Call change_context once. Call read_source for math.js with side before and with side after. Then call plan with two titles, and show stop 1 with side before and show stop 2 with side after. Each stop has only one spoken sentence. Explain the observed clamp change and its effect on negative input. No external tools or repository changes.'});
 host=await createWorkspacePlugins({root,runner,callbackUrl:'http://127.0.0.1:19876/plugins/linear/callback'});
 await host.request({project,plugin:'git',operation:'install'});await host.request({project,plugin:'git',operation:'enable'});
 const result=await host.request({project,operation:'action',input:{action:'tour',base,head,mode:'feature',text:'Give exactly two short stops: before math.js and after math.js. Use change_context, read_source both sides, plan two stops, then show each source side. Explain the clamp change. Do not inspect the live worktree.'}});
 receipt.runDir=result.runDir;console.log(JSON.stringify({event:'started',runDir:result.runDir,receiptFile}));
 const deadline=Date.now()+300000;while(runner.active&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,1000));
 if(runner.active){runner.cancel();throw Error('Live subscription provider exceeded 300-second verification limit');}
 const doc=readTour(root),descriptor=JSON.parse(fs.readFileSync(path.join(result.runDir,'run.json'),'utf8')),trace=jsonLines(path.join(result.runDir,'tools.jsonl'));
 receipt.agentRun=doc.agentRun;receipt.traceCalls=trace.filter(e=>e.type==='cosight.tool').map(e=>({name:e.name,arguments:e.arguments}));receipt.stopCount=doc.stops.length;receipt.planCount=doc.plan.length;
 receipt.usageEvents=jsonLines(path.join(result.runDir,'stdout.jsonl')).filter(e=>e.type==='turn.completed').map(e=>({type:e.type,usage:e.usage}));
 assert.equal(doc.agentRun.error,'','Real provider did not finish cleanly');assert.equal(doc.agentRun.serenaEnabled,false);assert.equal(doc.plan.length,2);assert.equal(doc.stops.length,2);
 const calls=receipt.traceCalls;assert.ok(calls.some(e=>e.name==='change_context'),'Missing actual change_context MCP trace');for(const side of ['before','after'])assert.ok(calls.some(e=>e.name==='read_source'&&e.arguments.path==='math.js'&&e.arguments.side===side),'Missing actual read_source '+side);
 assert.ok(calls.some(e=>e.name==='plan'));assert.equal(calls.filter(e=>e.name==='show').length,2);
 for(const side of ['before','after']){
  const expected=sources[side],snapshot=descriptor.sourceRoots[side];assert.equal(fs.readFileSync(path.join(snapshot,'math.js'),'utf8'),expected);
  const stop=doc.stops.find(s=>s.source?.side===side);assert.ok(stop,'Missing '+side+' stop provenance');assert.equal(stop.source.revision,side==='before'?base:head);assert.equal(fs.readFileSync(path.join(root,stop.fileUrl),'utf8'),expected);
 }
 assert.equal(git('rev-parse','HEAD'),originalHead);assert.equal(git('status','--porcelain=v1','--untracked-files=all'),originalStatus);assert.equal(fs.readFileSync(path.join(project,'math.js'),'utf8'),dirty);assert.equal(fs.readFileSync(path.join(project,'untracked.txt'),'utf8'),'original untracked bytes\n');
 receipt.sourceVerified={before:base,after:head,archivedBytesMatch:true,worktreeUnchanged:true,headUnchanged:true,divergentMainPreserved:true};receipt.passed=true;
}catch(error){receipt.error=error.message;process.exitCode=1;}finally{
 if(runner.active)runner.cancel();if(host)await host.close();fs.mkdirSync(path.dirname(receiptFile),{recursive:true});fs.writeFileSync(receiptFile,JSON.stringify(receipt,null,2));console.log(JSON.stringify({event:'finished',passed:receipt.passed,error:receipt.error,receiptFile,folder}));
}
