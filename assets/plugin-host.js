import {Context,Service} from 'cordis';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {projectKey} from './library.js';
import {binary} from './agent-config.js';
import {plugins,definition} from './plugins/catalog.js';

const read=(file,fallback)=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return fallback;}};
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.part',JSON.stringify(value,null,2));fs.renameSync(file+'.part',file);};
export function analysisDirectory(root,project){return path.join(root,'projects',projectKey(project),'analysis');}
export function analysisResults(root,project){
  try{project=fs.realpathSync(project);}catch{ /* saved results can outlive their source folder */ }
  const directory=path.join(analysisDirectory(root,project),'runs');
  return (fs.existsSync(directory)?fs.readdirSync(directory):[]).filter(id=>/^[0-9]+-[a-f0-9]+$/.test(id)).sort().reverse().slice(0,30).map(id=>read(path.join(directory,id,'result.json'),null)).filter(Boolean);
}
export function agentAnalysisResults(root,project){
  let remaining=64000;
  return analysisResults(root,project).slice(0,5).map(record=>{
    const result=record.result;
    if(!result)return record;
    const preview={...record,result:{summary:result.summary,warnings:result.warnings,coverage:result.coverage,findings:result.findings?.slice(0,20),graph:result.graph?{nodes:result.graph.nodes.slice(0,50),edges:result.graph.edges.slice(0,100)}:undefined},detail:'Agent preview omits native raw output and caps findings/graph. Full saved analysis is available in the Analysis panel.'};
    const length=JSON.stringify(preview).length;
    if(length>remaining)return {...record,result:{summary:result.summary},detail:'Evidence omitted from the bounded agent preview. Inspect the Analysis panel and verify current source.'};
    remaining-=length;return preview;
  });
}
export function canonicalProject(project){
  if(typeof project!=='string'||!path.isAbsolute(project))throw Error('Choose an absolute project folder');
  const real=fs.realpathSync(project);
  if(!fs.statSync(real).isDirectory())throw Error('Choose a project folder');
  return real;
}

/** One Cordis application per open project. A plugin registration never leaks
 * into another project's registry or configuration. Existing app code is exposed
 * as a service, rather than copied or rewritten into a new agent framework. */
export async function createPluginHost({root,store,runner,catalog=plugins,namespace='analysis'}){
  const sessions=new Map();let closed=false;
  async function open(project){
    if(closed)throw Error('Plugin host is closed');
    project=canonicalProject(project);
    if(!sessions.has(project))sessions.set(project,createSession(project));
    return sessions.get(project);
  }
  async function createSession(project){
    const ctx=new Context(),tools=new Map(),views=new Map(),fibers=new Map(),active=new Map();
    const directory=path.join(root,'projects',projectKey(project),namespace),configFile=path.join(directory,'plugins.json');
    const config=read(configFile,{});
    const installed=read(path.join(root,'toolchains','installed.json'),{});
    class Core extends Service {constructor(c){super(c,'cosight');this.project=project;this.store=store;this.runner=runner;}}
    class Analysis extends Service {
      constructor(c){super(c,'analysis');}
      registerTool(owner,tool){
        const id=owner+'.'+tool.id;
        if(tools.has(id))throw Error('Duplicate analysis tool '+id);
        this.ctx.effect(()=>{tools.set(id,{...tool,owner});return ()=>{if(tools.get(id)?.execute===tool.execute)tools.delete(id);};});
      }
      registerView(owner,view){
        const id=owner+'.'+view.id;
        this.ctx.effect(()=>{views.set(id,{...view,owner});return ()=>views.delete(id);});
      }
    }
    await ctx.plugin(Core);await ctx.plugin(Analysis);
    let mutations=Promise.resolve();
    const serial=fn=>{const next=mutations.then(fn);mutations=next.catch(()=>{});return next;};
    async function activate(spec,enabled){
      if(!enabled){
        for(const job of active.values())if(job.plugin===spec.id)job.controller.abort();
        await Promise.allSettled([...active.values()].filter(j=>j.plugin===spec.id).map(j=>j.done));
        await fibers.get(spec.id)?.dispose();fibers.delete(spec.id);return;
      }
      if(!fibers.has(spec.id))fibers.set(spec.id,await ctx.plugin(definition(spec)));
    }
    for(const spec of catalog)await activate(spec,config[spec.id]?.enabled??spec.defaultEnabled??spec.bundled);
    function defaultCommand(spec){return installed[spec.id]?.command||spec.command||'';}
    function commandFor(spec){return binary(config[spec.id]?.command||defaultCommand(spec));}
    function status(){
      return {project,plugins:catalog.map(spec=>{
        const command=spec.bundled?'':commandFor(spec);let available=!!spec.bundled;
        if(command)try{fs.accessSync(command,fs.constants.X_OK);available=true;}catch{}
        return {id:spec.id,title:spec.title,description:spec.description,languages:spec.languages,bundled:spec.bundled,enabled:fibers.has(spec.id),available,command:config[spec.id]?.command||defaultCommand(spec),state:!fibers.has(spec.id)?'disabled':available?(spec.bundled?'ready':'configured'):'needs-install'};
      }),tools:[...tools.entries()].map(([id,{execute,...tool}])=>({...tool,id})),views:[...views.values()],running:[...active.values()].map(j=>({id:j.id,plugin:j.plugin,tool:j.tool,startedAt:j.startedAt})),results:analysisResults(root,project)};
    }
    return {
      status,
      refresh(spec){return serial(async()=>{await activate(spec,false);await activate(spec,config[spec.id]?.enabled??spec.defaultEnabled??spec.bundled);});},
      // Rich direct capabilities share the same Cordis ownership and cancellation
      // as background analyzers. Release the mutation queue before awaiting work.
      invoke(input){return serial(async()=>{
        const spec=catalog.find(p=>p.id===input.plugin),tool=tools.get(input.plugin+'.'+input.tool);
        if(!spec||!tool)throw Error('Enable this plugin before using its tools');
        const id=Date.now()+'-'+crypto.randomBytes(4).toString('hex'),controller=new AbortController();
        const signal=input.signal?AbortSignal.any([controller.signal,input.signal]):controller.signal;
        const job={id,plugin:spec.id,tool:input.tool,controller,startedAt:new Date().toISOString()};
        active.set(id,job);
        job.done=Promise.resolve().then(()=>{signal.throwIfAborted();return tool.execute(input.input||{},{project:input.sourceProject||project,cache:directory,signal,command:commandFor(spec)});}).finally(()=>active.delete(id));
        job.done.catch(()=>{});
        return {done:job.done};
      }).then(({done})=>done);},
      configure(input){return serial(async()=>{
        const spec=catalog.find(p=>p.id===input.plugin);if(!spec)throw Error('Unknown plugin');
        if(typeof input.enabled!=='boolean')throw Error('Set enabled to true or false');
        if(input.command!==undefined&&(typeof input.command!=='string'||!input.command.trim()||input.command.length>2000))throw Error('Enter the executable name or absolute path');
        const previous=config[spec.id];
        // Retire active work before changing its executable or registrations.
        await activate(spec,false);
        config[spec.id]={enabled:input.enabled,...(!spec.bundled?{command:input.command||previous?.command||defaultCommand(spec)}:{})};
        try{await activate(spec,input.enabled);write(configFile,config);}catch(e){
          await activate(spec,false);if(previous)config[spec.id]=previous;else delete config[spec.id];await activate(spec,previous?.enabled??spec.defaultEnabled??spec.bundled);throw e;
        }
        return status();
      });},
      run(input){return serial(async()=>{
        const spec=catalog.find(p=>p.id===input.plugin),tool=tools.get(input.plugin+'.'+input.tool);
        if(!spec||!tool)throw Error('Enable this plugin before running its tools');
        if(active.size)throw Error('Wait for the current analysis or cancel it first');
        if(!status().plugins.find(p=>p.id===spec.id).available)throw Error(`Install ${spec.title} and set its executable path`);
        const values=input.input||{},properties=tool.inputSchema.properties;
        if(typeof values!=='object'||Array.isArray(values))throw Error('Tool input must be an object');
        for(const [key,value] of Object.entries(values))if(!properties[key]||typeof value!=='string'||value.length>2000||(properties[key].enum&&!properties[key].enum.includes(value)))throw Error('Invalid tool input: '+key);
        const id=Date.now()+'-'+crypto.randomBytes(4).toString('hex'),runDir=path.join(directory,'runs',id);
        fs.mkdirSync(runDir,{recursive:true});
        const controller=new AbortController(),startedAt=new Date().toISOString();
        const job={id,plugin:spec.id,tool:input.tool,controller,startedAt};
        const request={id,project,plugin:spec.id,tool:input.tool,input:values,startedAt};
        write(path.join(runDir,'request.json'),request);
        active.set(id,job);
        job.done=Promise.resolve().then(()=>tool.execute(values,{project,directory:runDir,cache:directory,cwd:runDir,signal:controller.signal,command:commandFor(spec),env:{ELECTRON_RUN_AS_NODE:'1'}})).then(result=>{
          write(path.join(runDir,'result.json'),{...request,state:controller.signal.aborted?'cancelled':'done',finishedAt:new Date().toISOString(),result});
        },error=>{write(path.join(runDir,'result.json'),{...request,state:controller.signal.aborted?'cancelled':'error',finishedAt:new Date().toISOString(),error:error.message});}).finally(()=>active.delete(id));
        return {id,project};
      });},
      cancel(id){const job=active.get(id);if(!job)throw Error('No running analysis with this id');job.controller.abort();return {ok:true};},
      async close(){for(const j of active.values())j.controller.abort();await Promise.allSettled([...active.values()].map(j=>j.done));await ctx.fiber.dispose();},
    };
  }
  return {
    async status(project){return (await open(project)).status();},
    async configure(input){return (await open(input.project)).configure(input);},
    async run(input){return (await open(input.project)).run(input);},
    async invoke(input){return (await open(input.project)).invoke(input);},
    async replaceSpec(spec){
      const index=catalog.findIndex(p=>p.id===spec.id),previous=index<0?null:catalog[index];
      if(index<0)catalog.push(spec);else catalog[index]=spec;
      try{for(const session of sessions.values())await (await session).refresh(spec);}
      catch(e){if(previous)catalog[index]=previous;else catalog.splice(catalog.indexOf(spec),1);for(const session of sessions.values())await (await session).refresh(previous||{...spec,defaultEnabled:false,bundled:false});throw e;}
    },
    async removeSpec(id){
      for(const session of sessions.values())await (await session).configure({plugin:id,enabled:false});
      const index=catalog.findIndex(p=>p.id===id);if(index>=0)catalog.splice(index,1);
    },
    async cancel(input){return (await open(input.project)).cancel(input.id);},
    async close(){closed=true;for(const session of sessions.values())await (await session).close();sessions.clear();},
  };
}
