import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createPluginHost,canonicalProject} from './plugin-host.js';
import {projectKey} from './library.js';
import {workspaceCatalog,validateManifest} from './plugins/workspace-contracts.js';
import {gitRequest} from './plugins/git.js';
import {createLinearConnector} from './plugins/linear.js';
import {createOptionalPlugins} from './plugins/optional.js';
import {optionalIds,agentOperations} from './plugins/optional-contracts.js';
import {runLocalPlugin} from './plugins/local-runtime.js';

const read=(file,fallback)=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return fallback;}};
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.part',JSON.stringify(value,null,2));fs.renameSync(file+'.part',file);};
const clone=value=>JSON.parse(JSON.stringify(value));
const text=(value,max=2000)=>typeof value==='string'?value.slice(0,max):'';

/** Product plugins reuse the analyzer host's Cordis lifetimes, with independent storage. */
export async function createWorkspacePlugins({root,runner,callbackUrl,linearConnector}){
  const registryFile=path.join(root,'plugins','installed.json');
  const installed=Object.assign(Object.create(null),read(registryFile,{})),errors=new Map(),executors=new Map();
  const linear=linearConnector||createLinearConnector({root,callbackUrl});
  const optional=createOptionalPlugins(root);
  const catalog=[];
  let closed=false,mutations=Promise.resolve();
  const packageEpoch=new Map(),projectEpoch=new Map();
  const epoch=(project,id)=>(packageEpoch.get(id)||'initial')+':'+(projectEpoch.get(project+'\n'+id)||'initial');
  const changeEpoch=(id,project)=>{const map=project?projectEpoch:packageEpoch;map.set(project?project+'\n'+id:id,crypto.randomBytes(12).toString('hex'));};
  for(const id of Object.keys(installed))changeEpoch(id);
  const serial=fn=>{const next=mutations.then(fn);mutations=next.catch(()=>{});return next;};
  const builtin=id=>workspaceCatalog.find(p=>p.id===id);
  function spec(manifest,execute){return {...manifest,bundled:true,defaultEnabled:false,languages:['Project'],view:{id:manifest.view||'tools',title:manifest.title||manifest.id},tools:manifest.capabilities.map(operation=>({id:operation,title:operation,inputSchema:{type:'object',properties:{}},execute:(input,job)=>{job.signal.throwIfAborted();return execute(operation,input,job);}}))};}
  async function load(manifest){
    validateManifest(manifest);
    if(!Array.isArray(manifest.capabilities)||!manifest.capabilities.length||manifest.capabilities.some(x=>typeof x!=='string'||!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(x)))throw Error('Declare supported plugin capabilities');
    if(builtin(manifest.id)){
      if(manifest.entry)throw Error('First-party plugin IDs cannot load custom code');
      if(optionalIds.includes(manifest.id))return (operation,input,job)=>optional.execute(manifest.id,operation,input,job);
      return manifest.id==='git'?(operation,input,job)=>gitRequest(job.project,operation,input,job):(operation,input,job)=>linear.request(operation,input,job);
    }
    if(!path.isAbsolute(manifest.entry||''))throw Error('Choose an absolute local plugin entry');
    const source=fs.readFileSync(manifest.entry),hash=crypto.createHash('sha256').update(source).digest('hex');
    if(manifest.hash&&manifest.hash!==hash)throw Error('Installed plugin source changed; replace the package');
    await runLocalPlugin(manifest.entry,{validate:true,timeoutMs:5000});
    return (operation,input,job)=>runLocalPlugin(manifest.entry,{operation,input,project:job.project,signal:job.signal});
  }
  for(const manifest of Object.values(installed)){
    try{const execute=await load(manifest);executors.set(manifest.id,execute);catalog.push(spec(manifest,execute));}catch(e){errors.set(manifest.id,e.message);}
  }
  const engine=await createPluginHost({root,runner,catalog,namespace:'workspace-plugins'});
  const associationFile=project=>path.join(root,'projects',projectKey(project),'workspace-plugins','associations.json');
  const associations=project=>read(associationFile(project),{workspace:null,project:null,issues:[]});
  async function status(project){
    project=canonicalProject(project);const state=await engine.status(project);
    const manifests=new Map([...workspaceCatalog,...Object.values(installed)].map(m=>[m.id,m]));
    return {project,plugins:[...manifests.values()].map(m=>{
      const p=state.plugins.find(x=>x.id===m.id);
      return {id:m.id,title:m.title||m.id,description:m.description||'',version:m.version,revision:epoch(project,m.id),capabilities:m.capabilities,installed:!!installed[m.id],enabled:!!p?.enabled,state:errors.has(m.id)?'error':!installed[m.id]?'available':p?.enabled?'active':'disabled',...(errors.has(m.id)?{error:errors.get(m.id)}:{})};
    }),views:state.views,associations:associations(project),connection:await linear.status()};
  }
  function cancelDependent(id,project){
    const running=runner?.active?.plugins?.includes(id)&&(!project||runner.active.project===project);
    const starting=runner?.starting&&runner.startingPlugins?.includes(id)&&(!project||runner.startingProject===project);
    if(running||starting)runner.cancel();
  }
  async function install(id,input,replace){
    const previous=installed[id];
    if(!replace&&previous)throw Error('Plugin is already installed');
    if(replace&&!previous)throw Error('Install this plugin first');
    let manifest=validateManifest(input.manifest||builtin(id)||previous);
    if(manifest.id!==id)throw Error('Plugin manifest id does not match');
    if(builtin(id))manifest=clone(builtin(id));
    else {
      if(!path.isAbsolute(manifest.entry||''))throw Error('Local plugin entry must be absolute');
      const source=fs.readFileSync(manifest.entry);if(source.length>1024*1024)throw Error('Local plugin entry exceeds 1 MB');
      const hash=crypto.createHash('sha256').update(source).digest('hex');
      const entry=path.join(root,'plugins','packages',id,manifest.version,hash,'entry.mjs');
      fs.mkdirSync(path.dirname(entry),{recursive:true});fs.writeFileSync(entry,source);manifest={...manifest,entry,hash};
    }
    const execute=await load(manifest); // Stage and validate before retiring the old version.
    cancelDependent(id);
    await engine.replaceSpec(spec(manifest,execute));
    installed[id]=manifest;executors.set(id,execute);errors.delete(id);
    changeEpoch(id);
    try{write(registryFile,installed);}catch(e){if(previous){installed[id]=previous;await engine.replaceSpec(spec(previous,await load(previous)));}else{delete installed[id];await engine.removeSpec(id);}throw e;}
  }
  async function enabled(project,id){const p=(await engine.status(project)).plugins.find(p=>p.id===id);if(!installed[id]||!p?.enabled)throw Error('Install and enable this plugin for the project first');if(errors.has(id))throw Error(errors.get(id));}
  async function call(project,id,input,revision,runId,requestSignal){
    await enabled(project,id);
    if(revision!==undefined&&revision!==epoch(project,id))throw Error('Plugin capabilities changed; start a fresh agent run');
    const {operation,...args}=input;
    if(runId!==undefined&&optionalIds.includes(id)&&!agentOperations[id].includes(operation))throw Error('This operation requires an explicit user action in the plugin panel');
    if(!installed[id].capabilities.includes(operation))throw Error('Plugin does not expose that capability');
    if(id==='linear'&&args.projectId!==undefined){args.project=args.projectId;delete args.projectId;}
    let sourceProject,signal=requestSignal;
    if(runId!==undefined){
      if(runner?.active?.runDir!==runId||runner.active.project!==project)throw Error('This plugin run is no longer active');
      if(runner.active.controller?.signal)signal=requestSignal?AbortSignal.any([requestSignal,runner.active.controller.signal]):runner.active.controller.signal;
      if(runner.active.sourceProject&&runner.active.sourceProject!==project){
        if(builtin(id))throw Error('Use the pinned Git and ticket evidence tools during a historical run');
        sourceProject=canonicalProject(runner.active.sourceProject);
      }
    }
    return engine.invoke({project,plugin:id,tool:operation,input:args,sourceProject,signal});
  }
  function associate(project,input){
    const previous=associations(project),next={...previous};
    for(const key of ['workspace','project'])if(Object.hasOwn(input,key)){
      const value=input[key];if(value!==null&&(!value||typeof value.id!=='string'||!value.id.trim()))throw Error('Association needs an id');
      next[key]=value===null?null:{id:text(value.id),name:text(value.name),url:text(value.url)};
    }
    if(Object.hasOwn(input,'issues')){
      if(!Array.isArray(input.issues)||input.issues.length>30)throw Error('Link at most 30 issues');
      next.issues=input.issues.map(issue=>{if(!issue||typeof issue.id!=='string'||!issue.id)throw Error('Issue needs an id');return {id:text(issue.id),identifier:text(issue.identifier),url:text(issue.url),title:text(issue.title),branch:issue.branch?text(issue.branch):null,linkedAt:issue.linkedAt||new Date().toISOString()};});
    }
    write(associationFile(project),next);return next;
  }
  async function action(project,input){
    if(!['tour','explain'].includes(input.action))throw Error('Choose explain or tour');
    if(!runner)throw Error('An agent runner is unavailable');
    const revision=epoch(project,'git');
    const comparison=await call(project,'git',{operation:'comparison',base:input.base,head:input.head,mode:input.mode||'feature'},revision);
    const issues=[],warnings=[];
    const branchKey=value=>String(value||'').replace(/^refs\/heads\//,'');
    const linked=(associations(project).issues||[]).filter(issue=>!issue.branch||branchKey(issue.branch)===branchKey(input.head)||issue.branch===comparison.head);
    const state=await engine.status(project);
    if(state.plugins.some(p=>p.id==='linear'&&p.enabled))for(const issue of linked){
      try{const evidence=await call(project,'linear',{operation:'issue',id:issue.id});try{const discussion=await call(project,'linear',{operation:'discussion',id:issue.id});evidence.comments=discussion.items;evidence.discussion={nextCursor:discussion.nextCursor||null,truncated:!!discussion.nextCursor};if(discussion.nextCursor)warnings.push(`${issue.identifier}: only the first discussion page was retrieved; further decisions may be missing. Open the ticket for the remaining comments.`);}catch(e){warnings.push('Issue discussion unavailable: '+e.message);}issues.push(evidence);}catch(e){warnings.push('Linked ticket unavailable: '+issue.identifier+' — '+e.message);}
    }
    const request=input.action==='explain'?'Explain what this branch added, why recorded ticket context says it was needed, architectural decisions when evidenced, impact, and possible improvements. Give a concise source-backed guided explanation.':'Take a guided source tour of what this feature branch changed, its recorded intent, decisions and impact. Label inferred rationale and suggested alternatives.';
    await enabled(project,'git');if(revision!==epoch(project,'git'))throw Error('Git capabilities changed while preparing this request; try again');
    return runner.start({project,text:text(input.text,16000)||request,kind:'tour',changeContext:{comparison,issues,warnings}});
  }
  return {
    status,
    async agentTools(project,{historical=false}={}){
      const state=await status(project);
      return state.plugins.filter(p=>p.enabled&&!p.error&&(!historical||!builtin(p.id))).flatMap(p=>p.capabilities.filter(operation=>!optionalIds.includes(p.id)||agentOperations[p.id].includes(operation)).map(operation=>({name:`plugin_${p.id}__${operation}`,plugin:p.id,operation,revision:p.revision,description:`${p.title}: ${operation}. ${optionalIds.includes(p.id)?'Read saved evidence; resultId/findingId identify source requests. ':''}${historical?'Runs against the pinned after-revision source snapshot.':'Read project-specific context. Git comparisons take base/head/mode; source takes revision/path; Linear issue/discussion take id; searches take query and optional projectId/cursor.'}`,inputSchema:{type:'object',properties:{},additionalProperties:true},...(builtin(p.id)?{annotations:{readOnlyHint:true,destructiveHint:false}}:{})})));
    },
    async finishOAuth(input){return linear.finish(input);},
    async request({project,plugin,operation,input={},revision,runId},{signal}={}){
      if(closed)throw Error('Plugin library is closed');project=canonicalProject(project);
      if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Plugin input must be an object');
      if(operation==='call')return call(project,plugin,input,revision,runId,signal);
      if(operation==='action')return action(project,input);
      if(operation==='insight-action'){
        await enabled(project,plugin);if(!optionalIds.includes(plugin))throw Error('Choose an evidence plugin');if(!runner)throw Error('An agent runner is unavailable');
        let evidence;if(plugin==='exercises'){const value=await call(project,plugin,{operation:'list'});evidence=value.tasks.find(t=>t.id===input.id);if(!evidence)throw Error('Exercise not found');if(evidence.sourceChanged)throw Error('Exercise source changed; update its context before taking a tour');}
        else{evidence=await call(project,plugin,{operation:'latest'});if(!evidence||evidence.id!==input.resultId||evidence.stale)throw Error('Evidence changed; refresh before explaining');if(input.findingId){const selected=evidence.findings.find(f=>f.id===input.findingId);if(!selected)throw Error('Finding not found');evidence={...evidence,findings:[selected],raw:undefined};}else evidence={...evidence,raw:undefined};}
        const instruction='Explain this project evidence with pertinent source and explanatory diagrams. Search and verify actual source ranges. Distinguish observed tool evidence, declared architecture policy and inferred design rationale. Offer architectural alternatives with tradeoffs and bounded verification steps. For exercises, guide investigation without doing the learner task for them. Do not run checks or change source. Evidence: '+JSON.stringify(evidence).slice(0,50000);
        const locations=plugin==='exercises'?evidence.locations:evidence.findings.flatMap(f=>f.locations),sourceHashes=plugin==='exercises'?Object.fromEntries(locations.filter(loc=>!loc.missing&&loc.hash).map(loc=>[loc.file,loc.hash])):evidence.sourceHashes;
        return runner.start({project,text:instruction,kind:'tour',insightContext:{plugin,resultId:evidence.id,findingId:input.findingId||null,sourceHashes,evidence}});
      }
      return serial(async()=>{
        if(operation==='install'||operation==='replace')await install(plugin,input,operation==='replace');
        else if(operation==='enable'){if(!installed[plugin]||errors.has(plugin))throw Error(errors.get(plugin)||'Install this plugin first');await engine.configure({project,plugin,enabled:true});changeEpoch(plugin,project);}
        else if(operation==='disable'){cancelDependent(plugin,project);await engine.configure({project,plugin,enabled:false});changeEpoch(plugin,project);}
        else if(operation==='remove'){cancelDependent(plugin);if(!installed[plugin])throw Error('Plugin is not installed');if(!errors.has(plugin))await engine.removeSpec(plugin);delete installed[plugin];executors.delete(plugin);errors.delete(plugin);changeEpoch(plugin);write(registryFile,installed);fs.rmSync(path.join(root,'plugins','packages',plugin),{recursive:true,force:true});}
        else if(operation==='associate'){await enabled(project,'linear');associate(project,input);}
        else if(operation==='connect'){await enabled(project,'linear');return linear.begin();}
        else if(operation==='disconnect'){await enabled(project,'linear');cancelDependent('linear');await linear.disconnect();}
        else throw Error('Unknown plugin operation');
        return status(project);
      });
    },
    async close(){closed=true;await engine.close();await linear.close();},
  };
}
