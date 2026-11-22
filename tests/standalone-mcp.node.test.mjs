import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {library} from '../assets/library.js';

function temp(t){fs.mkdirSync('temp',{recursive:true});const root=fs.mkdtempSync(path.resolve('temp/standalone-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('shared agent preferences survive reopening and new projects without sharing project instructions',t=>{
  const root=temp(t),store=library(root);
  store.saveAgentPreferences({agent:{provider:'codex',command:'',model:'',args:[]}});
  store.saveSettings('/project-a',{instructions:'Trace requests'});
  assert.equal(library(root).settings('/project-b').agent.provider,'codex');
  assert.equal(library(root).settings('/project-b').instructions,'');
  assert.equal(library(root).settings('/project-a').instructions,'Trace requests');
  store.saveAgentPreferences({agent:{provider:'claude',command:'',model:'',args:[]}});
  assert.equal(library(root).settings('/project-a').agent.provider,'claude');
  assert.equal(library(root).settings('/project-b').agent.provider,'claude');
  assert.equal(library(root).settings('/project-a').instructions,'Trace requests');
});
test('standalone MCP connects without app or descriptor, reads overview, publishes two distinct tours and preserves source',async t=>{
  const root=temp(t),project=path.join(root,'source'),data=path.join(root,'data');fs.mkdirSync(project);
  fs.writeFileSync(path.join(project,'README.md'),'# Independent project\n\nA source-linked project overview.');
  const source='def greet():\n    return "hello"\n';fs.writeFileSync(path.join(project,'main.py'),source);
  library(data).saveSettings(project,{instructions:'Keep explanations short.'});
  const client=new Client({name:'independent-agent-test',version:'1'});t.after(()=>client.close());
  const executable=process.env.COSIGHT_TEST_APP||process.execPath;
  const script=process.env.COSIGHT_TEST_APP?path.resolve(path.dirname(executable),'../Resources/app.asar/assets/agent-mcp.js'):path.resolve('assets/agent-mcp.js');
  await client.connect(new StdioClientTransport({command:executable,args:[script,'standalone','--project',project,'--data-dir',data],...(process.env.COSIGHT_TEST_APP?{env:{ELECTRON_RUN_AS_NODE:'1'}}:{})}));
  assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['plan','show','project_overview','list_tours']);
  const overview=JSON.parse((await client.callTool({name:'project_overview',arguments:{}})).content[0].text);
  assert.equal(overview.overview.name,'Independent project');assert.equal(overview.instructions,'Keep explanations short.');
  assert.equal(fs.existsSync(path.join(data,'tour.json')),false);
  for(const question of ['First question','Second question']){
    assert.ok(!(await client.callTool({name:'plan',arguments:{question,stops:['Greet']}})).isError);
    assert.ok(!(await client.callTool({name:'show',arguments:{file:'main.py',start:1,end:2,stop:1,say:'The function returns hello.'}})).isError);
    assert.equal(JSON.parse(fs.readFileSync(path.join(data,'tour.json'))).phase,'done');
  }
  const tours=JSON.parse((await client.callTool({name:'list_tours',arguments:{}})).content[0].text);
  assert.equal(tours.length,2);assert.equal(new Set(tours.map(t=>t.tourId)).size,2);
  assert.equal(fs.readFileSync(path.join(project,'main.py'),'utf8'),source);
});
