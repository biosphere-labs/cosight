import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runProcess} from './process.js';

const worker=fileURLToPath(new URL('./worker.js',import.meta.url));
const field=(description,extra={})=>({type:'string',description,...extra});
const schema=properties=>({type:'object',properties,additionalProperties:false});
const gitnexusEnv=job=>({GITNEXUS_HOME:path.join(job.cache,'gitnexus'),GITNEXUS_STORAGE_PATH:path.join(job.cache,'gitnexus-index'),GITNEXUS_NO_UPDATE_NOTIFIER:'1'});
const text=(value,name)=>{
  if(typeof value!=='string'||!value.trim()||value.length>2000)throw Error(`Enter ${name} (maximum 2000 characters)`);
  return value;
};
const native=action=>async(input,job)=>{
  fs.writeFileSync(path.join(job.directory,'input.json'),JSON.stringify(input));
  const {stdout}=await runProcess(process.execPath,[worker,action,job.project,path.join(job.directory,'input.json')],job);
  return JSON.parse(stdout);
};
export const plugins=[
  {
    id:'patterns',title:'Structural patterns',languages:['JavaScript','TypeScript','TSX','Python','HTML','CSS'],bundled:true,
    description:'Search syntax trees with ast-grep. Matches carry files and line numbers; they do not establish whole-program behavior.',
    view:{id:'patterns',title:'Patterns'},
    tools:[{id:'search',title:'Find a code pattern',inputSchema:schema({language:field('Language',{enum:['JavaScript','TypeScript','TSX','Python','HTML','CSS']}),pattern:field('Syntax pattern, e.g. console.log($$$ARGS) or print($$$ARGS)')}),execute:native('patterns')}],
  },
  {
    id:'dependencies',title:'Dependency Cruiser',languages:['JavaScript','TypeScript','TSX'],bundled:true,
    description:'Module imports, circular dependencies and unresolved imports. Optional specialist; other languages remain available through other plugins.',
    view:{id:'dependencies',title:'Modules'},
    tools:[{id:'graph',title:'Map module dependencies',inputSchema:schema({}),execute:native('dependencies')}],
  },
  {
    id:'gitnexus',title:'GitNexus',languages:['Multiple (installed version determines coverage)'],bundled:false,command:'gitnexus',
    description:'Local graph indexing and symbol exploration. Uses your installed CLI; not bundled (PolyForm Noncommercial). Index and registry are stored in CoSight project data. No wiki/LLM API calls.',
    view:{id:'gitnexus',title:'Connections'},
    tools:[
      {id:'index',title:'Build or refresh code graph',inputSchema:schema({}),execute:async(_,job)=>{
        const result=await runProcess(job.command,['analyze',job.project,'--index-only','--skip-git','--drop-embeddings','--workers','2'],{...job,env:{...job.env,...gitnexusEnv(job)}});
        return {summary:'GitNexus index command completed. Read its output for coverage and skipped files.',raw:result,warnings:['Static inferred paths are not recorded runtime execution.']};
      }},
      ...['query','context','impact'].map(action=>({id:action,title:{query:'Search execution flows',context:'Inspect symbol connections',impact:'Inspect change impact'}[action],inputSchema:schema({query:field(action==='query'?'Search text':'Symbol name')}),execute:async(input,job)=>{
        const value=text(input.query,action==='query'?'search text':'a symbol');
        if(value.startsWith('-'))throw Error('Enter search text or a symbol name, not a CLI option');
        const result=await runProcess(job.command,[action,action==='query'?'--query':value,...(action==='query'?[value]:[]),'--repo',job.project,'--limit','20'],{...job,cwd:job.project,env:{...job.env,...gitnexusEnv(job)}});
        let raw;try{raw=JSON.parse(result.stdout);}catch{raw=result;}
        if(raw?.error||raw?.partial)throw Error(raw.error||'GitNexus reported partial results; inspect its index before continuing');
        let graph;
        // Preserve the provider's native evidence, and normalize only relationships
        // it actually returned. Impact depth buckets are not direct-call edges.
        if(action==='context'&&raw?.symbol){
          const symbol=raw.symbol,center=symbol.uid||symbol.id;
          const nodes=new Map([[center,{id:center,label:symbol.name,file:symbol.filePath,line:symbol.startLine}]]),edges=[];
          for(const [direction,groups] of [['incoming',raw.incoming],['outgoing',raw.outgoing]])for(const [kind,items] of Object.entries(groups||{}))for(const item of items){
            const id=item.uid||item.id;if(!id)continue;
            nodes.set(id,{id,label:item.name,file:item.filePath,line:item.startLine});
            edges.push({from:direction==='incoming'?id:center,to:direction==='incoming'?center:id,kind});
          }
          graph={nodes:[...nodes.values()],edges};
        }
        return {summary:`GitNexus ${action} results`,...(graph?{graph}:{}),raw,warnings:['Results describe the last GitNexus index. Refresh it after source changes.','Static relationships are inferred; impact buckets do not establish a direct call path.']};
      }})),
    ],
  },
  {
    id:'joern',title:'Joern',languages:['Multiple (installed frontends determine coverage)'],bundled:false,command:'joern',
    description:'Build a code property graph and extract static method/call relationships with a fixed Scala script. Requires a local Joern distribution and its JVM. Full data-flow queries are a later extension.',
    view:{id:'joern',title:'Call graph'},
    tools:[{id:'calls',title:'Extract method and call graph',inputSchema:schema({}),execute:async(_,job)=>{
      const script=path.join(job.directory,'joern-calls.sc'),output=path.join(job.directory,'joern.json');
      // The external JVM cannot read a script through Electron's ASAR VFS.
      fs.copyFileSync(fileURLToPath(new URL('./joern-calls.sc',import.meta.url)),script);
      const result=await runProcess(job.command,['-J-Xmx2G','--script',script,'--param',`inputPath=${job.project}`,'--param',`outFile=${output}`],{...job,timeout:600000});
      const methods=JSON.parse(fs.readFileSync(output,'utf8'));
      const nodes=methods.map(m=>({id:m.id,label:m.name,file:m.file,line:m.line}));
      const ids=new Set(nodes.map(n=>n.id));
      return {summary:`${nodes.length} methods from Joern (maximum 200).`,graph:{nodes,edges:methods.flatMap(m=>m.calls.filter(id=>ids.has(id)).map(to=>({from:m.id,to,kind:'calls'})))},raw:{methods,stderr:result.stderr},warnings:['Static call resolution can be incomplete. Method list capped at 200; this is not a complete architecture or runtime trace.']};
    }}],
  },
];

// Each adapter is an ordinary Cordis plugin. The application owns the domain
// registries; Cordis supplies dependency activation and reversible lifetimes.
export function definition(spec){
  return {name:`cosight-${spec.id}`,inject:['analysis'],apply(ctx){
    ctx.analysis.registerView(spec.id,spec.view);
    for(const tool of spec.tools)ctx.analysis.registerTool(spec.id,tool);
  }};
}
