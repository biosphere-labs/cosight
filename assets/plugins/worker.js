// Heavy/native analyzers run outside the server so they can be cancelled and do
// not block voice, tour delivery, or another project's UI.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runProcess} from './process.js';

export const ignored=new Set(['node_modules','.git','.hg','.svn','.venv','venv','dist','build','coverage','temp','artifacts','__pycache__','.gitnexus','.serena']);
export function sourceFiles(project,max=10000){
  const files=[];let truncated=false;
  function walk(dir){
    for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      if(ignored.has(entry.name)||entry.isSymbolicLink())continue;
      if(files.length>=max){truncated=true;return;}
      const full=path.join(dir,entry.name);
      if(entry.isDirectory())walk(full);else if(entry.isFile())files.push(full);
    }
  }
  walk(project);return {files,truncated};
}

async function main(){
  const [action,project,inputFile]=process.argv.slice(2),input=JSON.parse(fs.readFileSync(inputFile,'utf8'));
  if(action==='patterns'){
    const {parse,registerDynamicLanguage}=await import('@ast-grep/napi');
    const {default:python}=await import('@ast-grep/lang-python');
    // Native parser loading cannot read Electron's virtual ASAR filesystem.
    // electron-builder unpacks these grammars beside the archive.
    registerDynamicLanguage({python:{...python,libraryPath:python.libraryPath.replace(/\.asar([\\/])/ ,'.asar.unpacked$1')}});
    const languages={JavaScript:['JavaScript',['.js','.mjs','.cjs','.jsx']],TypeScript:['TypeScript',['.ts','.mts','.cts']],TSX:['Tsx',['.tsx']],Python:['python',['.py']],HTML:['Html',['.html']],CSS:['Css',['.css']]};
    const spec=languages[input.language];
    if(!spec)throw Error('Select a supported language');
    if(typeof input.pattern!=='string'||!input.pattern.trim()||input.pattern.length>2000)throw Error('Enter a syntax pattern (maximum 2000 characters)');
    const inventory=sourceFiles(project),findings=[],warnings=[];let scanned=0,skipped=0,capped=false;
    // Validate the pattern even if there are no files of this language.
    parse(spec[0],'').root().findAll(input.pattern);
    for(const file of inventory.files.filter(f=>spec[1].includes(path.extname(f)))){
      if(fs.statSync(file).size>1024*1024){skipped++;continue;}
      scanned++;
      const root=parse(spec[0],fs.readFileSync(file,'utf8')).root();
      for(const node of root.findAll(input.pattern)){
        const range=node.range();
        findings.push({file:path.relative(project,file),line:range.start.line+1,endLine:range.end.line+1,text:node.text().slice(0,1200)});
        if(findings.length>=500){capped=true;break;}
      }
      if(capped)break;
    }
    if(capped)warnings.push('Stopped at 500 matches; narrow the pattern.');
    if(inventory.truncated)warnings.push('File discovery capped at 10,000 files.');
    if(skipped)warnings.push(`${skipped} files larger than 1 MB skipped.`);
    console.log(JSON.stringify({summary:`${findings.length} ${input.language} matches in ${scanned} scanned files.`,findings,warnings,coverage:{language:input.language,scanned,skipped,truncated:capped||inventory.truncated},raw:{pattern:input.pattern}}));
  }else if(action==='dependencies'){
    const main=fileURLToPath(import.meta.resolve('dependency-cruiser'));
    const cli=path.resolve(path.dirname(main),'../../bin/dependency-cruiser.mjs');
    // Do not load executable dependency-cruiser or webpack configuration from
    // the inspected project. Analysis uses this fixed, read-only configuration.
    const {stdout}=await runProcess(process.execPath,[cli,'.','--no-config','--output-type','json','--exclude','(^|/)(node_modules|dist|build|coverage|temp|artifacts|\\.git|\\.venv)(/|$)','--do-not-follow','node_modules'],{cwd:project,ownGroup:false});
    const raw=JSON.parse(stdout),modules=raw.modules||[];
    const local=modules.filter(m=>!m.coreModule&&!m.matchesDoNotFollow),ids=new Set(local.map(m=>m.source));
    const nodes=local.map(m=>({id:m.source,label:m.source,file:m.source}));
    const edges=local.flatMap(m=>(m.dependencies||[]).filter(d=>ids.has(d.resolved)).map(d=>({from:m.source,to:d.resolved,kind:'imports'})));
    const findings=modules.flatMap(m=>(m.dependencies||[]).filter(d=>d.circular||d.couldNotResolve).map(d=>({file:m.source,text:`${d.circular?'Circular dependency':'Unresolved import'}: ${d.module}`,kind:d.circular?'cycle':'unresolved'})));
    console.log(JSON.stringify({summary:`${nodes.length} modules, ${edges.length} local imports, ${findings.length} findings.`,graph:{nodes,edges},findings,warnings:['JavaScript/TypeScript module imports only. Dynamic runtime connections and other languages are not covered.'],coverage:{languages:['JavaScript','TypeScript','TSX']},raw}));
  }else throw Error('Unknown worker action');
}
if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
