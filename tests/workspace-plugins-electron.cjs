// Shared real-producer UI scenario. Native Electron requires explicit opt-in.
const {_electron:electron,chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {execFileSync,fork}=require('node:child_process');
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
async function runWorkspacePluginsTest(){
 const headless=process.env.COSIGHT_TEST_HEADLESS==='1',packaged=!headless&&!!process.env.COSIGHT_TEST_APP,label=headless?'headless web':'Electron';
 const artifact=(kind='',extension='png')=>path.resolve(process.env.COSIGHT_TEST_ARTIFACT_DIR||'artifacts/verification',`workspace-plugins-${headless?'browser':'electron'}${packaged?'-packaged':''}${kind?'-'+kind:''}.${extension}`);
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cosight-plugin-electron-'))),data=path.join(root,'data'),project=path.join(root,'project'),receiptDir=path.resolve(process.env.COSIGHT_TEST_ARTIFACT_DIR||'artifacts/verification');fs.mkdirSync(project);fs.mkdirSync(data);fs.mkdirSync(receiptDir,{recursive:true});
 git(project,'init','-b','main');git(project,'config','user.name','UI fixture');git(project,'config','user.email','fixture@example.invalid');
 const source=path.join(project,'shared.js'),commit=title=>{git(project,'add','.');git(project,'commit','-m',title);return git(project,'rev-parse','HEAD');};
 fs.writeFileSync(source,'export const value = "initial";\n');commit('Initial');git(project,'checkout','-b','feature');fs.writeFileSync(source,'export const value = "feature";\n');const feature=commit('Feature value');git(project,'checkout','main');fs.writeFileSync(source,'export const value = "main";\n');const main=commit('Main value');fs.writeFileSync(source,'export const value = "dirty live";\n');
 const original={head:git(project,'rev-parse','HEAD'),status:git(project,'status','--porcelain=v1'),source:fs.readFileSync(source,'utf8')};
 fs.writeFileSync(path.join(data,'tour.json'),JSON.stringify({project,tourId:'',v:1,phase:'idle',stops:[],asides:[],plan:[]}));
 const customEntry=path.join(root,'local.mjs');fs.writeFileSync(customEntry,'export async function execute(operation,input,{project}) {return {operation,echo:input.message,project};}\n');
 let app,server,page,packagedAppPath=null,port=headless?0:18329,serverOutput='';const errors=[],checks={},actionRequests=[];
 const env={...process.env,COSIGHT_DATA_DIR:data,COSIGHT_USER_DATA_DIR:path.join(root,'profile'),COSIGHT_EXPERIMENTAL_PLUGINS:'0',KOKORO_ENSURE:''};
 try{
 if(headless){
   // The real server owns isolated temporary data and reports its allocated port over IPC.
   server=fork(path.resolve('assets/tour-server.js'),[data,'0','127.0.0.1'],{env,stdio:['ignore','pipe','pipe','ipc']});
   for(const stream of [server.stdout,server.stderr])stream.on('data',chunk=>{serverOutput=(serverOutput+chunk.toString()).slice(-65536);});
   port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>finish(Error('Headless tour-server startup timed out')),20000);const fail=error=>finish(error),exit=(code,signal)=>finish(Error('Headless tour-server exited before ready: '+code+' '+signal));function finish(error,value){clearTimeout(timer);server.removeListener('error',fail);server.removeListener('exit',exit);server.removeListener('message',ready);error?reject(error):resolve(value);}function ready(message){if(Number.isInteger(message?.port)&&message.port>0)finish(null,message.port);}server.once('error',fail);server.once('exit',exit);server.on('message',ready);});
   app=await chromium.launch({headless:true});page=await app.newPage({viewport:{width:1440,height:940}});
 }else{
   app=await electron.launch({...(process.env.COSIGHT_TEST_APP?{executablePath:process.env.COSIGHT_TEST_APP,args:process.platform==='linux'?['--no-sandbox','--disable-dev-shm-usage']:[]}:{args:['.']}),env:{...env,COSIGHT_PORT:String(port)}});
   if(packaged){packagedAppPath=await app.evaluate(({app})=>app.getAppPath());assert.ok(packagedAppPath.endsWith('app.asar'));if(process.env.COSIGHT_EXPECT_ASAR)assert.equal(packagedAppPath,process.env.COSIGHT_EXPECT_ASAR);}
   app.process().on('exit',(code,signal)=>console.log('Electron exited',code,signal));page=await app.firstWindow();
 }
 page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/plugins'){try{const input=request.postDataJSON();if(input.operation==='action')actionRequests.push(input);}catch{}}});page.on('pageerror',e=>errors.push(e.message));if(headless)await page.goto(`http://127.0.0.1:${port}/`);else await page.waitForURL(`http://127.0.0.1:${port}/**`);await page.waitForLoadState('load');
 const api=async(route,input)=>{const result=input===undefined?await page.request.get(new URL(route,page.url()).href):await page.request.post(new URL(route,page.url()).href,{data:input});const value=await result.json();assert.ok(result.ok(),JSON.stringify(value));return value;};
 const status=()=>api('plugins?project='+encodeURIComponent(project));
 await api('settings',{project,agent:{provider:'custom',command:process.execPath,args:[path.resolve('tests/fixture-change-agent.mjs'),'{mcpConfig}','{runDir}']},serena:{enabled:false},instructions:'Use the selected source revision.'});
 console.log('Opening project',project);await page.locator('#homeRecent button').filter({hasText:project}).click();await page.locator('#homePlugins').click();
 await page.getByRole('button',{name:'Available',exact:true}).click();
 const gitCard=()=>page.locator('#workspacePlugins .wp-card').filter({has:page.locator('strong',{hasText:'Git history'})});
 console.log('Installing Git');await gitCard().getByRole('button',{name:'Install',exact:true}).click();
 await page.getByRole('button',{name:'Installed',exact:true}).click();await gitCard().getByRole('button',{name:'Enable',exact:true}).click();
 await page.locator('.wp-graph circle').first().waitFor();assert.equal(await page.locator('.wp-graph circle').count(),3);assert.equal(await page.locator('.wp-graph path').count(),2);await page.getByText('main · Uncommitted changes present',{exact:true}).waitFor();checks.realCommitGraph=true;checks.realParentEdgesAndDirtyInfo=true;
 await page.locator('.wp-ref').getByText('feature',{exact:true}).click();
 await page.waitForFunction(()=>[...document.querySelectorAll('#workspacePlugins label')].find(e=>e.firstChild.textContent==='Head')?.querySelector('select').value==='feature');
 await page.getByText('1 commits · 1 changed files',{exact:true}).waitFor();checks.clickRefUpdatesComparison=true;
 await page.screenshot({path:artifact('history')});
 await gitCard().getByRole('button',{name:'Disable',exact:true}).click();assert.equal((await status()).plugins.find(p=>p.id==='git').enabled,false);await page.waitForFunction(()=>!document.querySelector('.wp-graph'));
 await gitCard().getByRole('button',{name:'Enable',exact:true}).click();await page.locator('.wp-graph circle').first().waitFor();
 await gitCard().getByRole('button',{name:'Remove',exact:true}).click();await page.getByText('No plugins installed. Explore Available to add one.',{exact:true}).waitFor();assert.equal((await status()).plugins.find(p=>p.id==='git').installed,false);
 await page.getByRole('button',{name:'Available',exact:true}).click();await gitCard().getByRole('button',{name:'Install',exact:true}).click();await page.getByRole('button',{name:'Installed',exact:true}).click();await gitCard().getByRole('button',{name:'Enable',exact:true}).click();checks.disableEnableRemoveReinstall=true;
 await page.reload();await page.locator('#homeRecent button').filter({hasText:project}).click();await page.locator('#homePlugins').click();await page.locator('.wp-graph circle').first().waitFor();assert.equal((await status()).plugins.find(p=>p.id==='git').enabled,true);checks.reloadPersistence=true;
 await page.getByRole('button',{name:'Available',exact:true}).click();const linearCard=()=>page.locator('#workspacePlugins .wp-card').filter({has:page.locator('strong',{hasText:'Linear',exact:true})});await linearCard().getByRole('button',{name:'Install',exact:true}).click();await page.getByRole('button',{name:'Installed',exact:true}).click();await linearCard().getByRole('button',{name:'Enable',exact:true}).click();await page.getByRole('button',{name:'Connect Linear',exact:true}).waitFor();assert.equal((await status()).connection.connected,false);checks.linearIndependentDisconnected=true;
 await page.getByText('Install a local plugin',{exact:true}).click();await page.getByLabel('Local plugin manifest JSON').fill(JSON.stringify({id:'ui-local',version:'1.0.0',api:1,entry:customEntry,capabilities:['inspect'],title:'UI local tool'}));await page.getByRole('button',{name:'Install or replace local plugin',exact:true}).click();const localCard=()=>page.locator('#workspacePlugins .wp-card').filter({has:page.locator('strong',{hasText:'UI local tool',exact:true})});await localCard().getByRole('button',{name:'Enable',exact:true}).click();await page.getByLabel('UI local tool JSON input').fill('{"message":"real UI payload"}');await page.getByRole('button',{name:'Run operation',exact:true}).click();await page.locator('#workspacePlugins pre').filter({hasText:'real UI payload'}).waitFor();checks.localPluginRealExecution=true;
 // Runtime replacement must execute new copied code, while Git remains active.
 fs.writeFileSync(customEntry,'export async function execute(operation,input,{project}) {return {operation,echo:"v2:"+input.message,project};}\n');
 if(!await page.getByLabel('Local plugin manifest JSON').isVisible())await page.getByText('Install a local plugin',{exact:true}).click();
 await page.getByLabel('Local plugin manifest JSON').fill(JSON.stringify({id:'ui-local',version:'2.0.0',api:1,entry:customEntry,capabilities:['inspect'],title:'UI local tool'}));
 await page.getByRole('button',{name:'Install or replace local plugin',exact:true}).click();
 await localCard().getByText('Version 2.0.0 · active',{exact:true}).waitFor();
 await page.getByLabel('UI local tool JSON input').fill('{"message":"replacement payload"}');await page.getByRole('button',{name:'Run operation',exact:true}).click();await page.locator('#workspacePlugins pre').filter({hasText:'v2:replacement payload'}).waitFor();
 assert.equal((await status()).plugins.find(p=>p.id==='git').enabled,true);assert.equal(await page.locator('.wp-graph circle').count(),3);checks.localPluginRuntimeReplacement=true;checks.gitUnaffectedByReplacement=true;
 await page.screenshot({path:artifact('replacement')});

 // Action selection must be restored after lifecycle resets; base=main, head=feature.
 await page.locator('.wp-ref').getByText('feature',{exact:true}).click();await page.getByText('1 commits · 1 changed files',{exact:true}).waitFor();await page.getByRole('button',{name:'Tour this feature',exact:true}).click();
 await page.waitForFunction(()=>window.doc?.question==='Feature revision tour from UI'&&window.doc.phase==='done'&&!document.body.classList.contains('home-mode'),null,{timeout:20000});
 const tour=await api('tour');assert.equal(tour.source.after,feature);assert.equal(tour.stops[0].source.revision,feature);const cited=await page.request.get(new URL(tour.stops[0].fileUrl,page.url()).href);assert.equal(await cited.text(),'export const value = "feature";\n');
 if(await page.locator('#voicePreparation').isVisible())await page.getByRole('button',{name:'Continue without voice'}).click();
 await page.waitForFunction(()=>document.getElementById('codewrap').textContent.includes('"feature"'));assert.ok(!(await page.locator('#codewrap').innerText()).includes('dirty live'));checks.visibleHistoricalSource=true;
 assert.equal(git(project,'rev-parse','HEAD'),original.head);assert.equal(git(project,'status','--porcelain=v1'),original.status);assert.equal(fs.readFileSync(source,'utf8'),original.source);checks.originalHeadWorktreeUnchanged=true;
 await page.screenshot({path:artifact('tour')});
 const firstRunNames=fs.readdirSync(path.join(data,'runs'));
 await page.locator('#bHome').click();await page.locator('#homePlugins').click();await page.locator('.wp-ref').getByText('feature',{exact:true}).click();await page.getByText('1 commits · 1 changed files',{exact:true}).waitFor();await page.getByRole('button',{name:'Explain changes',exact:true}).click();
 await page.waitForFunction(previous=>window.doc?.tourId!==previous&&window.doc?.question==='Feature revision tour from UI'&&window.doc.phase==='done'&&!document.body.classList.contains('home-mode'),tour.tourId,{timeout:20000});
 const explanation=await api('tour');assert.notEqual(explanation.tourId,tour.tourId);assert.equal(explanation.source.after,feature);assert.equal(explanation.stops[0].source.revision,feature);const explanationCited=await page.request.get(new URL(explanation.stops[0].fileUrl,page.url()).href);assert.equal(await explanationCited.text(),'export const value = "feature";\n');
 const secondRunNames=fs.readdirSync(path.join(data,'runs')),newRuns=secondRunNames.filter(name=>!firstRunNames.includes(name));assert.equal(newRuns.length,1);const explanationPrompt=fs.readFileSync(path.join(data,'runs',newRuns[0],'prompt.txt'),'utf8');assert.match(explanationPrompt,/Explain what this branch added/);if(packaged){const mcp=JSON.parse(fs.readFileSync(path.join(data,'runs',newRuns[0],'mcp.json'),'utf8')).mcpServers.cosight;assert.equal(mcp.args[0],path.join(packagedAppPath,'assets/agent-mcp.js'));assert.equal(mcp.command,process.env.COSIGHT_TEST_APP);checks.packagedMcpSource=true;}assert.deepEqual(actionRequests.map(request=>request.input.action),['tour','explain']);
 if(await page.locator('#voicePreparation').isVisible())await page.getByRole('button',{name:'Continue without voice'}).click();await page.waitForFunction(()=>document.getElementById('codewrap').textContent.includes('"feature"'));
 assert.equal(git(project,'rev-parse','HEAD'),original.head);assert.equal(git(project,'status','--porcelain=v1'),original.status);assert.equal(fs.readFileSync(source,'utf8'),original.source);checks.explainChangesNewPinnedRun=true;checks.bothActionsPreserveOriginalWorktree=true;
 await page.screenshot({path:artifact('explanation')});

 assert.deepEqual(errors,[]);
 fs.writeFileSync(artifact('','json'),JSON.stringify({at:new Date().toISOString(),packaged,headless,packagedAppPath,runtime:headless?'headless Chromium + real Node tour-server':process.env.COSIGHT_TEST_APP||'development Electron',root,data,project,feature,main,original,tourId:tour.tourId,explanationTourId:explanation.tourId,explanationRun:newRuns[0],actionRequests,checks,screenshots:Object.fromEntries(['history','replacement','tour','explanation'].map(kind=>[kind,artifact(kind)])),pageErrors:errors,scope:`${headless?'Headless Chromium web UI':'Native Electron UI'}, real Node HTTP plugin host, real divergent Git repository, copied custom package replacement, deterministic custom CLI -> MCP -> pinned Tour and Explain runs. No LLM inference, Linear OAuth consent, or ticket retrieval tested.${headless?' Electron, desktop bridges and native packaging are outside this headless scope.':''}`},null,2));
 console.log('PASS workspace plugins '+label,JSON.stringify(checks));
 }catch(error){console.error('Original verification error:',error);fs.writeFileSync(artifact('failure','json'),JSON.stringify({at:new Date().toISOString(),packaged,headless,root,checks,pageErrors:errors,serverOutput,error:error.message},null,2));if(page&&!page.isClosed()){console.error((await page.locator('body').innerText()).slice(-7000));await page.screenshot({path:artifact('failure')}).catch(()=>{});}throw error;}
 finally{
   if(app){if(headless)await app.close().catch(()=>{});else{const child=app.process(),exited=child.exitCode!==null||child.signalCode!==null?Promise.resolve():new Promise(resolve=>child.once('exit',resolve));app.close().catch(()=>{});let timer;try{await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Owned Electron process did not exit during teardown')),10000);})]);}finally{clearTimeout(timer);}}}
   if(server){
     if(server.exitCode===null&&server.signalCode===null){server.kill('SIGTERM');await new Promise(resolve=>{const timer=setTimeout(()=>{server.kill('SIGKILL');resolve();},5000);server.once('exit',()=>{clearTimeout(timer);resolve();});});}
   }else if(!headless){const identity=await fetch(`http://127.0.0.1:${port}/whoami`,{signal:AbortSignal.timeout(3000)}).then(r=>r.json()).catch(()=>null);if(identity?.root===data)process.kill(identity.pid);}
 }
}
module.exports={runWorkspacePluginsTest};
if(require.main===module){
 if(process.env.COSIGHT_TEST_HEADLESS!=='1'&&process.env.COSIGHT_TEST_ELECTRON!=='1'&&!process.env.COSIGHT_TEST_APP){console.error('Native Electron tests require COSIGHT_TEST_ELECTRON=1 or COSIGHT_TEST_APP. For Docker use node tests/workspace-plugins-browser.cjs.');process.exitCode=1;}
 else runWorkspacePluginsTest().catch(error=>{console.error(error);process.exitCode=1;});
}
