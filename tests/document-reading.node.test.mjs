import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {discoverDocuments,readDocument,selectedDocument,selectDocument,readDocumentRange} from '../assets/document-reader.js';
import {AgentRunner} from '../assets/agent-runner.js';
import {library} from '../assets/library.js';
import {readTour,tourTools,projectDocument,writeTour} from '../assets/tour-writer.js';
import {createWorkspacePlugins} from '../assets/workspace-plugins.js';
import {DEFAULT_INSTRUCTIONS} from '../assets/default-instructions.js';
const git=(project,...args)=>execFileSync('git',args,{cwd:project,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function setup(t){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cosight-doc-'))),project=path.join(root,'project'),data=path.join(root,'data');fs.mkdirSync(project);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,project,data};}
test('discovery prioritizes existing handover/readme and selection stores only canonical path',t=>{
  const {root,project,data}=setup(t);const handover=path.join(project,'HANDOVER.md');fs.writeFileSync(handover,'# Handover\n\n## Details\ncheckpoint: deadbeef\nbranch: feature/work\n');fs.writeFileSync(path.join(project,'README.markdown'),'# Overview\n');
  for(const folder of ['node_modules','.git','dist','temp']){fs.mkdirSync(path.join(project,folder));fs.writeFileSync(path.join(project,folder,'hidden.md'),'# Hidden');}
  fs.symlinkSync(handover,path.join(project,'alias.md'));const found=discoverDocuments(project);assert.deepEqual(found.documents.map(d=>path.basename(d.path)),['HANDOVER.md','README.markdown']);assert.equal(found.documents[0].title,'Handover');
  const snapshot=selectDocument(data,project,'HANDOVER.md');assert.equal(snapshot.path,handover);assert.equal(selectedDocument(data,project),handover);assert.equal(snapshot.sections.length,2);assert.equal(snapshot.sections[0].endLine,2);assert.ok(snapshot.references.some(r=>r.value==='deadbeef'&&r.line===4));assert.ok(snapshot.references.some(r=>r.value==='feature/work'&&r.kind==='branch'));
  const metadata=fs.readdirSync(path.join(data,'projects'),{recursive:true}).filter(f=>String(f).endsWith('.json'));assert.equal(metadata.length,1);const saved=fs.readFileSync(path.join(data,'projects',metadata[0]),'utf8');assert.deepEqual(JSON.parse(saved),{path:handover});assert.ok(!saved.includes('deadbeef'));
  fs.writeFileSync(handover,'# Refreshed\nnew source text');assert.match(readDocument(project,handover).text,/new source/);assert.throws(()=>readDocument(project,handover,{expectedHash:snapshot.hash}),/changed/);
  fs.renameSync(handover,path.join(root,'moved.md'));assert.throws(()=>readDocument(project,handover),/moved or deleted/);
});
test('checkout and merge references are inert candidates with conservative prose and line provenance',t=>{
  const {root,project}=setup(t),marker=path.join(root,'never-execute');
  const lines=[
    '# Checkpoint handover',
    '`git checkout feature/foo`',
    'git switch -c "new/topic" main',
    'git merge -m "not a ref or command" --no-ff "feature/foo"',
    'git checkout --detach `abc1234`',
    'We checked out branch `feature/foo` at the checkpoint.',
    'Then merged "release/handoff".',
    'We checked out the documentation and merged comments into the explanation.',
    'git checkout -- main.js',
    `git merge --no-ff feature/foo; touch ${marker}`,
    'branch: feature/foo; git checkout feature/foo',
    `git checkout $(touch ${marker})`,
    'git switch --mystery-option ignored-argument',
    'We checked out main and then merged deadbeef.',
    'git merge --no-ff `feature/backticks`',
  ];
  const file=path.join(project,'HANDOVER.md'),text=lines.join('\n');fs.writeFileSync(file,text);const refs=readDocument(project,file).references;
  const expected=[['feature/foo',2,'checkout'],['new/topic',3,'checkout'],['main',3,'checkout'],['feature/foo',4,'merge'],['abc1234',5,'checkout'],['feature/foo',6,'checkout'],['release/handoff',7,'merge'],['feature/foo',10,'merge'],['feature/foo',11,'checkout'],['main',14,'checkout'],['deadbeef',14,'merge'],['feature/backticks',15,'merge']];
  for(const [value,line,kind]of expected)assert.ok(refs.some(ref=>ref.value===value&&ref.line===line&&ref.kind===kind),JSON.stringify({value,line,kind,refs}));
  assert.equal(refs.filter(ref=>ref.line===11&&ref.value==='feature/foo').length,1);assert.ok(!refs.some(ref=>[8,9,12,13].includes(ref.line)),JSON.stringify(refs));assert.ok(!refs.some(ref=>['not','ref','touch','documentation','comments','explanation','main.js'].includes(ref.value)));assert.equal(fs.existsSync(marker),false);assert.equal(fs.readFileSync(file,'utf8'),text);
});
test('explicit external documents and bounded UTF8 Markdown validation',t=>{
  const {root,project,data}=setup(t),external=path.join(root,'outside.md');fs.writeFileSync(external,'# External\n'+Array.from({length:400},(_,i)=>`line ${i}`).join('\n'));const doc=selectDocument(data,project,external);assert.equal(doc.path,external);assert.equal(fs.existsSync(path.join(project,'outside.md')),false);assert.throws(()=>readDocument(project,'../outside.md'),/explicit absolute/);
  fs.symlinkSync(root,path.join(project,'link'));assert.throws(()=>readDocument(project,'link/outside.md'),/explicit absolute/);
  const first=readDocumentRange(project,doc);assert.equal(first.start,1);assert.equal(first.end,120);assert.equal(first.truncated,true);assert.throws(()=>readDocumentRange(project,doc,{start:1,end:301}),/300 lines/);
  fs.writeFileSync(path.join(root,'bad.md'),Buffer.from([0xff]));assert.throws(()=>readDocument(project,path.join(root,'bad.md')),/UTF-8/);fs.writeFileSync(path.join(root,'big.md'),'x'.repeat(1024*1024+1));assert.throws(()=>readDocument(project,path.join(root,'big.md')),/1 MB/);assert.throws(()=>readDocument(project,path.join(root,'other.txt')),/Markdown/);
});
test('document shows enforce provenance, diagrams and real source while legacy file requirement remains',t=>{
  const {project,data}=setup(t);fs.writeFileSync(path.join(project,'notes.md'),'# Idea\nConcept\nCode\n');fs.writeFileSync(path.join(project,'main.js'),'const x = 1;\n');const documentContext=readDocument(project,'notes.md');writeTour(data,{...projectDocument(project),tourId:'document',documentContext:{path:documentContext.path,hash:documentContext.hash}});const writer=tourTools({root:data,project,tourId:'document',documentContext});writer.plan({question:'Explain',stops:['Idea','Code']});
  assert.throws(()=>writer.show({stop:1,say:'Idea',codeRelevant:false,documentStart:1,documentEnd:2}),/diagram/);assert.throws(()=>writer.show({stop:1,say:'Idea',codeRelevant:false,svg:'flowchart LR; A-->B',documentStart:0,documentEnd:2}),/document line/);writer.show({stop:1,say:'Idea',codeRelevant:false,svg:'flowchart LR; A-->B',documentStart:1,documentEnd:2});
  assert.throws(()=>writer.show({stop:2,say:'Code',codeRelevant:true,svg:'flowchart LR; A-->B',documentStart:3,documentEnd:3}),/source file/);assert.throws(()=>writer.show({stop:2,say:'Code',file:'main.js',start:99,end:100,codeRelevant:true,svg:'flowchart LR; A-->B',documentStart:3,documentEnd:3}),/actual source/);
  writer.show({stop:2,say:'Code',file:'main.js',start:1,end:1,codeRelevant:true,svg:'flowchart LR; A-->B',documentStart:3,documentEnd:3});const doc=readTour(data);assert.equal(doc.stops[0].fileUrl,'');assert.equal(doc.stops[0].mode,'map');assert.equal(doc.stops[0].document.hash,documentContext.hash);assert.equal(doc.stops[1].mode,'split');assert.match(fs.readFileSync(path.join(data,doc.stops[1].fileUrl),'utf8'),/const x/);
  writeTour(data,{...projectDocument(project),tourId:'legacy'});const legacy=tourTools({root:data,project,tourId:'legacy'});legacy.plan({question:'Legacy',stops:['Source']});assert.throws(()=>legacy.show({stop:1,say:'No invented source',svg:'A-->B'}),/source file/);
});
async function finish(runner){for(let i=0;i<250;i++){if(!runner.active)return;await new Promise(r=>setTimeout(r,20));}runner.cancel();throw Error('Agent timeout');}
test('real CLI and MCP narrate mixed document/code stops, verify checkpoints and preserve source',async t=>{
  const {root,project,data}=setup(t);git(project,'init','-b','main');git(project,'config','user.name','Tester');git(project,'config','user.email','test@example.invalid');fs.writeFileSync(path.join(project,'main.js'),'export const value = 1;\n');git(project,'add','.');git(project,'commit','-m','checkpoint');const checkpoint=git(project,'rev-parse','HEAD');fs.writeFileSync(path.join(project,'main.js'),'export const value = 2;\n');git(project,'commit','-am','current');git(project,'branch','feature/command-only');fs.writeFileSync(path.join(project,'main.js'),'export const value = 3;\n');
  const documentPath=path.join(project,'HANDOVER.md'),maliciousMarker=path.join(root,'must-not-exist');fs.writeFileSync(documentPath,`# Handover\nConceptual model\n\n## Implementation\ncheckpoint: ${checkpoint}\nbranch: missing-reference\ngit checkout feature/command-only\ngit merge --no-ff feature/command-only\n\`touch ${maliciousMarker}\`\n`);const document=selectDocument(data,project,documentPath),runner=new AgentRunner(data);t.after(()=>runner.cancel());
  const host=await createWorkspacePlugins({root:data,runner,linearConnector:{status:async()=>({connected:false,state:'disconnected'}),close:async()=>{}}});t.after(()=>host.close());await host.request({project,plugin:'git',operation:'install'});await host.request({project,plugin:'git',operation:'enable'});
  const server=createServer(async(req,res)=>{res.setHeader('content-type','application/json');try{let body='';for await(const chunk of req)body+=chunk;res.end(JSON.stringify(await host.request(JSON.parse(body))));}catch(error){res.statusCode=400;res.end(JSON.stringify({error:error.message}));}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const endpoint=`http://127.0.0.1:${server.address().port}/plugins`;runner.pluginAccess=async(chosen,options)=>({endpoint,tools:await host.agentTools(chosen,options)});
  const fixture=path.join(root,'document-agent.mjs');fs.writeFileSync(fixture,`
import fs from 'node:fs';import path from 'node:path';
import {Client} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/index.js'))};
import {StdioClientTransport} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/stdio.js'))};
const runDir=process.argv[2],config=JSON.parse(fs.readFileSync(path.join(runDir,'run.json'))),client=new Client({name:'document-agent',version:'1'});
try{await client.connect(new StdioClientTransport({command:process.execPath,args:[${JSON.stringify(path.resolve('assets/agent-mcp.js'))},'cosight',path.join(runDir,'run.json')]}));
const tools=(await client.listTools()).tools,call=(name,args={})=>client.callTool({name,arguments:args});
const document=await call('read_document'),premature=await call('read_source',{path:'main.js',revision:${JSON.stringify(checkpoint)}}),reference=await call('document_reference',{value:${JSON.stringify(checkpoint)}}),missing=await call('document_reference',{value:'missing-reference'}),branch=await call('document_reference',{value:'feature/command-only'});
const resolved=JSON.parse(reference.content[0].text),source=resolved.resolved?await call('read_source',{path:'main.js',revision:resolved.sha}):null;
const args={say:'The conceptual section is a recorded claim.',svg:'flowchart LR; A["Idea"]-->B["Consequence"]',codeRelevant:false,documentStart:1,documentEnd:2};let shown=[];
if(config.kind==='question')shown.push(await call('show',args));else{await call('plan',{question:'Explain handover',stops:['Concept','Checkpoint']});shown.push(await call('show',{...args,stop:1}));shown.push(await call('show',{stop:2,say:'At this verified checkpoint the value is one.',svg:'flowchart LR; A["Module"]-->B["Value"]',codeRelevant:true,documentStart:4,documentEnd:6,file:'main.js',start:1,end:1,revision:resolved.sha}));}
fs.writeFileSync(path.join(runDir,'document-receipt.json'),JSON.stringify({tools,document,premature,reference,missing,branch,source,shown}));}finally{await client.close();}
`);
  const additions='Keep additions visible. '+'z'.repeat(20000)+' END OF PROJECT ADDITIONS';
  library(data).saveSettings(project,{instructions:additions,agent:{provider:'custom',command:process.execPath,args:[fixture,'{runDir}']},serena:{enabled:false,command:'unused',args:[]}});
  const head=git(project,'rev-parse','HEAD'),status=git(project,'status','--porcelain=v1'),started=await runner.start({project,text:'Read my handover',documentContext:{path:document.path,hash:document.hash}});await finish(runner);assert.equal(runner.last.error,'');const receipt=JSON.parse(fs.readFileSync(path.join(started.runDir,'document-receipt.json'))),descriptor=JSON.parse(fs.readFileSync(path.join(started.runDir,'run.json'))),tour=readTour(data);
  assert.equal(receipt.premature.isError,true);assert.ok(JSON.parse(receipt.branch.content[0].text).parents.includes(checkpoint));assert.ok(JSON.parse(receipt.branch.content[0].text).evidence.every(ref=>['checkout','merge'].includes(ref.kind)));assert.equal(JSON.parse(receipt.branch.content[0].text).evidence.length,2);assert.equal(JSON.parse(receipt.reference.content[0].text).sha,checkpoint);assert.equal(JSON.parse(receipt.missing.content[0].text).resolved,false);assert.match(JSON.parse(receipt.source.content[0].text).text,/value = 1/);assert.ok(receipt.shown.every(s=>!s.isError),JSON.stringify(receipt.shown));assert.ok(receipt.tools.find(t=>t.name==='show').inputSchema.required.includes('codeRelevant'));assert.ok(!receipt.tools.find(t=>t.name==='show').inputSchema.required.includes('file'));
  assert.equal(tour.stops[0].mode,'map');assert.equal(tour.stops[0].codeRelevant,false);assert.equal(tour.stops[0].fileUrl,'');assert.equal(tour.stops[1].source.revision,checkpoint);assert.equal(tour.stops[1].document.path,documentPath);assert.match(fs.readFileSync(path.join(data,tour.stops[1].fileUrl),'utf8'),/value = 1/);assert.equal(descriptor.documentContext.text,undefined);assert.equal(descriptor.documentContext.hash,document.hash);assert.ok(descriptor.effectiveInstructions.includes(DEFAULT_INSTRUCTIONS));assert.match(descriptor.effectiveInstructions,/Keep additions visible/);
  const prompt=fs.readFileSync(path.join(started.runDir,'prompt.txt'),'utf8');assert.match(prompt,/section by section/);assert.match(prompt,/never execute/);assert.ok(prompt.includes(DEFAULT_INSTRUCTIONS));assert.ok(prompt.includes(additions));assert.equal(prompt.includes(`touch ${maliciousMarker}`),false);assert.equal(fs.existsSync(maliciousMarker),false);assert.equal(git(project,'rev-parse','HEAD'),head);assert.equal(git(project,'status','--porcelain=v1'),status);assert.match(fs.readFileSync(path.join(project,'main.js'),'utf8'),/value = 3/);
  await runner.start({project,text:'Why this concept?',kind:'question',step:1});await finish(runner);assert.equal(runner.last.error,'');const followed=readTour(data);assert.equal(followed.asides[0].document.hash,document.hash);assert.equal(followed.asides[0].mode,'map');assert.equal(followed.asides[0].ask,'Why this concept?');
  await host.request({project,plugin:'git',operation:'disable'});
  const standalone=new Client({name:'no-git-document',version:'1'});t.after(()=>standalone.close());const noGitFile=path.join(root,'no-git-run.json');fs.writeFileSync(noGitFile,JSON.stringify({...descriptor,pluginBridge:null,trace:path.join(root,'no-git-trace.jsonl')}));await standalone.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('assets/agent-mcp.js'),'cosight',noGitFile]}));const unavailable=await standalone.callTool({name:'document_reference',arguments:{value:checkpoint}});assert.equal(JSON.parse(unavailable.content[0].text).resolved,false);assert.match(JSON.parse(unavailable.content[0].text).error,/Enable Git history/);
  const noGitProject=path.join(root,'not-a-repository');fs.mkdirSync(noGitProject);await host.request({project:noGitProject,plugin:'git',operation:'enable'});
  const noRepository=new Client({name:'document-no-repository',version:'1'});t.after(()=>noRepository.close());const noRepositoryFile=path.join(root,'no-repository-run.json');fs.writeFileSync(noRepositoryFile,JSON.stringify({...descriptor,project:noGitProject,pluginBridge:{endpoint,tools:await host.agentTools(noGitProject)},trace:path.join(root,'no-repository-trace.jsonl')}));await noRepository.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('assets/agent-mcp.js'),'cosight',noRepositoryFile]}));const noRepositoryResult=JSON.parse((await noRepository.callTool({name:'document_reference',arguments:{value:checkpoint}})).content[0].text);assert.equal(noRepositoryResult.resolved,false);assert.equal(noRepositoryResult.noGit,true);
  fs.writeFileSync(documentPath,document.text+'\nChanged by user.');await assert.rejects(runner.start({project,text:'Follow again',kind:'question'}),/changed/);assert.equal(readTour(data).documentContext.hash,document.hash);
});
test('same-commit document aliases retain independent line evidence for both source sections',async t=>{
  const {root,project,data}=setup(t);git(project,'init','-b','main');git(project,'config','user.name','Tester');git(project,'config','user.email','test@example.invalid');fs.writeFileSync(path.join(project,'main.js'),'export const shared = true;\n');git(project,'add','.');git(project,'commit','-m','shared checkpoint');const sha=git(project,'rev-parse','HEAD');git(project,'branch','release/checkpoint');
  const file=path.join(project,'ALIASES.md');fs.writeFileSync(file,'# Main section\nbranch: main\n\n# Release section\nbranch: release/checkpoint\n# Unrelated section\nNo checkpoint is mentioned here.');const snapshot=readDocument(project,file),documentContext={path:snapshot.path,hash:snapshot.hash};
  writeTour(data,{...projectDocument(project),tourId:'alias-tour',documentContext});
  const host=await createWorkspacePlugins({root:data,linearConnector:{status:async()=>({connected:false,state:'disconnected'}),close:async()=>{}}});t.after(()=>host.close());await host.request({project,plugin:'git',operation:'install'});await host.request({project,plugin:'git',operation:'enable'});
  const server=createServer(async(req,res)=>{res.setHeader('content-type','application/json');try{let body='';for await(const chunk of req)body+=chunk;res.end(JSON.stringify(await host.request(JSON.parse(body))));}catch(error){res.statusCode=400;res.end(JSON.stringify({error:error.message}));}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const descriptor=path.join(root,'alias-run.json');fs.writeFileSync(descriptor,JSON.stringify({root:data,project,tourId:'alias-tour',documentContext,trace:path.join(root,'alias-trace.jsonl'),pluginBridge:{endpoint:`http://127.0.0.1:${server.address().port}/plugins`,tools:await host.agentTools(project)}}));
  const client=new Client({name:'alias-regression',version:'1'});t.after(()=>client.close());await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('assets/agent-mcp.js'),'cosight',descriptor]}));const call=(name,args={})=>client.callTool({name,arguments:args});
  const main=JSON.parse((await call('document_reference',{value:'main'})).content[0].text);assert.equal(main.sha,sha);const firstSource=JSON.parse((await call('read_source',{path:'main.js',revision:sha})).content[0].text);
  const release=JSON.parse((await call('document_reference',{value:'release/checkpoint'})).content[0].text);assert.equal(release.sha,sha);const secondSource=JSON.parse((await call('read_source',{path:'main.js',revision:sha})).content[0].text);assert.equal(firstSource.text,secondSource.text);
  await call('plan',{question:'Explain both checkpoint aliases',stops:['Main','Release']});
  const base={say:'This verified checkpoint exports the shared value.',svg:'flowchart LR; A["Checkpoint"]-->B["Module"]',codeRelevant:true,file:'main.js',start:1,end:1,revision:sha};
  const first=await call('show',{...base,stop:1,documentStart:1,documentEnd:2});assert.ok(!first.isError,JSON.stringify(first));const second=await call('show',{...base,stop:2,documentStart:4,documentEnd:5});assert.ok(!second.isError,JSON.stringify(second));
  const unrelated=await call('show',{...base,stop:1,documentStart:6,documentEnd:7});assert.equal(unrelated.isError,true);assert.match(unrelated.content[0].text,/reference must appear/);
  // Resolving an earlier alias again must not evict the release alias either.
  await call('document_reference',{value:'main'});assert.ok(!(await call('show',{...base,stop:2,documentStart:4,documentEnd:5})).isError);
  const doc=readTour(data);assert.equal(doc.stops[0].source.reference.value,'main');assert.deepEqual(doc.stops[0].source.reference.evidence.map(ref=>ref.line),[2]);assert.equal(doc.stops[1].source.reference.value,'release/checkpoint');assert.deepEqual(doc.stops[1].source.reference.evidence.map(ref=>ref.line),[5]);assert.equal(doc.stops[0].source.revision,sha);assert.equal(doc.stops[1].source.revision,sha);
});
