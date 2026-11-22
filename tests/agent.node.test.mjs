import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {cleanEnvironment,invocation,defaultSerena,validateConfig} from '../assets/agent-config.js';
import {projectDocument,writeTour,readTour,tourTools} from '../assets/tour-writer.js';
import {createPluginHost} from '../assets/plugin-host.js';
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'cosight-agent-'));
test('subscription adapters remove API keys and endpoint overrides, and require Codex ChatGPT login',()=>{
  const env=cleanEnvironment({PATH:'/bin',HOME:'/home/me',OPENAI_API_KEY:'secret',ANTHROPIC_AUTH_TOKEN:'secret',GOOGLE_API_KEY:'secret',OPENAI_BASE_URL:'wrong',CLAUDE_CODE_USE_BEDROCK:'1',AGY_LLM_GATEWAY_URL:'wrong',AGY_ADC_AUTH:'1'});
  assert.deepEqual(env,{PATH:'/bin',HOME:'/home/me'});
  const spec=invocation({provider:'codex',model:''},{prompt:'Tour',mcpConfig:'config'}, {serena:{command:'uvx',args:['serena']}});
  assert.ok(spec.args.includes('forced_login_method="chatgpt"'));
  assert.ok(spec.args.includes('mcp_servers.serena.required=true'));
  assert.ok(spec.args.includes('read-only'));
  assert.equal(validateConfig({}).serena.enabled,true);
  assert.ok(defaultSerena.args.includes('{project}'));
});
test('custom agent arguments expand as arguments, never shell code',()=>{
  const spec=invocation({provider:'custom',command:'my-agent',args:['-p','{prompt}','--mcp','{mcpConfig}']},{prompt:'hello; $(bad)',mcpConfig:'/a b/config.json'},{});
  assert.deepEqual(spec.args,['-p','hello; $(bad)','--mcp','/a b/config.json']);
});
test('tour writer reads the real project file, bounds ranges, and refuses source outside the project',t=>{
  const root=temp(),project=path.join(root,'project');fs.mkdirSync(project);fs.writeFileSync(path.join(project,'main.py'),'def run():\n    return 1\n');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  writeTour(root,{...projectDocument(project),tourId:'t-1'});const writer=tourTools({root,project,tourId:'t-1'});
  writer.plan({question:'How?',stops:['Run']});writer.show({stop:1,file:'main.py',start:1,end:999,say:'It returns one.'});
  const doc=readTour(root);assert.equal(doc.stops[0].end,3);assert.match(fs.readFileSync(path.join(root,doc.stops[0].fileUrl),'utf8'),/return 1/);
  assert.throws(()=>writer.show({stop:1,file:'../tour.json',start:1,end:1,say:'No'}),/inside/);
  writeTour(root,{...doc,tourId:'t-2'});assert.throws(()=>writer.plan({question:'late',stops:['No']}),/no longer/);
});
test('real MCP client plans and delivers a tour through provider-neutral stdio tools',async t=>{
  const root=temp(),project=path.join(root,'project');fs.mkdirSync(project);fs.writeFileSync(path.join(project,'main.py'),'def run():\n    return 1\n');
  writeTour(root,{...projectDocument(project),tourId:'t-3'});
  const descriptor=path.join(root,'run.json');fs.writeFileSync(descriptor,JSON.stringify({root,project,tourId:'t-3',experimentalPlugins:true,trace:path.join(root,'trace.jsonl')}));
  const client=new Client({name:'test',version:'1'});t.after(async()=>{await client.close();fs.rmSync(root,{recursive:true,force:true});});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('assets/agent-mcp.js'),'cosight',descriptor]}));
  assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['plan','show','analysis_results']);
  const analysis=await client.callTool({name:'analysis_results',arguments:{}});
  assert.deepEqual(JSON.parse(analysis.content[0].text),[]);
  const host=await createPluginHost({root});t.after(()=>host.close());
  await host.run({project,plugin:'patterns',tool:'search',input:{language:'Python',pattern:'return $VALUE'}});
  for(let n=0;n<100;n++){if(!(await host.status(project)).running.length)break;await new Promise(r=>setTimeout(r,20));}
  const saved=JSON.parse((await client.callTool({name:'analysis_results',arguments:{}})).content[0].text);
  assert.equal(saved.length,1);assert.equal(saved[0].state,'done');assert.equal(saved[0].result.findings[0].file,'main.py');assert.equal(saved[0].result.findings[0].line,2);
  await client.callTool({name:'plan',arguments:{question:'What runs?',stops:['Run']}});
  const response=await client.callTool({name:'show',arguments:{file:'main.py',start:1,end:2,stop:1,say:'Run returns one.'}});
  assert.ok(!response.isError);assert.equal(readTour(root).stops[0].say,'Run returns one.');
  assert.match(fs.readFileSync(path.join(root,'trace.jsonl'),'utf8'),/cosight.tool/);
});

test('Antigravity permission setup preserves existing settings, backs up the original, and is idempotent',async t=>{
  const {enableAntigravity,antigravityRules}=await import('../assets/agent-permissions.js');
  const root=temp(),file=path.join(root,'settings.json');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const original={theme:'dark',permissions:{allow:['command(git)'],deny:['command(rm)'],ask:['mcp(other/*)']}};
  fs.writeFileSync(file,JSON.stringify(original));const result=enableAntigravity(file),saved=JSON.parse(fs.readFileSync(file));
  assert.deepEqual(JSON.parse(fs.readFileSync(result.backup)),original);
  assert.deepEqual(saved.permissions.deny,original.permissions.deny);assert.deepEqual(saved.permissions.ask,original.permissions.ask);
  assert.equal(saved.theme,'dark');assert.ok(antigravityRules.every(rule=>saved.permissions.allow.includes(rule)));
  assert.equal(enableAntigravity(file).changed,false);
  assert.ok(!antigravityRules.includes('mcp(*)'));assert.ok(!antigravityRules.includes('command(*)'));
});

test('provider errors preserve usage limits and denied-tool diagnostics',async t=>{
  const {providerError}=await import('../assets/agent-runner.js');const root=temp();t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'stdout.jsonl'),JSON.stringify({type:'result',is_error:true,result:'Weekly limit reached'}));assert.equal(providerError(root),'Weekly limit reached');
  fs.writeFileSync(path.join(root,'stdout.jsonl'),JSON.stringify({event:'result',result:{status:'SUCCESS',denied_actions:[{action:'mcp'}]}}));assert.match(providerError(root),/denied required tools/);
});

test('a follow-up question cannot replace the route and is attached to its original stop', t=>{
  const root=temp(),project=path.join(root,'project');fs.mkdirSync(project);fs.writeFileSync(path.join(project,'welcome.js'),'function welcome() { return "hello"; }');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  writeTour(root,{...projectDocument(project),tourId:'t-question'});
  const normal=tourTools({root,project,tourId:'t-question'});normal.plan({question:'How?',stops:['Welcome']});normal.show({file:'welcome.js',start:1,end:1,stop:1,say:'Hello.'});
  const followup=tourTools({root,project,tourId:'t-question',kind:'question',question:'Why hello?',from:1});
  assert.throws(()=>followup.plan({question:'Replacement',stops:['No']}),/do not replace/);
  followup.show({file:'welcome.js',start:1,end:1,say:'It is the return value.',ask:'Wrong question',from:99});
  const doc=readTour(root);assert.equal(doc.plan.length,1);assert.equal(doc.stops.length,1);assert.equal(doc.asides[0].ask,'Why hello?');assert.equal(doc.asides[0].from,1);
});
