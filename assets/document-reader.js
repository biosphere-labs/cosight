import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const MAX_BYTES=1024*1024;
const skip=new Set(['.git','node_modules','dist','temp','tmp','build','.next','.cache']);
const markdown=file=>/\.(md|markdown)$/i.test(file);
function projectPath(project){const real=fs.realpathSync(project);if(!fs.statSync(real).isDirectory())throw Error('Choose a project directory');return real;}
function selectedFile(root,project){return path.join(root,'projects',crypto.createHash('sha256').update(projectPath(project)).digest('hex'),'selected-document.json');}
export function selectedDocument(root,project){try{const value=JSON.parse(fs.readFileSync(selectedFile(root,project),'utf8'));return typeof value.path==='string'?value.path:null;}catch{return null;}}
function references(lines){
  const refs=[],seen=new Set();
  const valid=value=>/^[A-Za-z0-9][A-Za-z0-9._\/~^-]{0,199}$/.test(value);
  const branchLike=value=>value.includes('/')||/^(main|master|develop|development|trunk|HEAD)$/i.test(value)||/^[a-f0-9]{7,64}$/i.test(value);
  const noArgument=new Set(['--detach','--no-ff','--ff','--ff-only','--no-edit','--edit','--squash','--commit','--no-commit','--quiet','-q','--force','-f','--track','-t','--no-track','--guess','--no-guess','--no-verify','--verify','--allow-unrelated-histories']);
  const createsBranch=new Set(['-b','-B','-c','-C','--create','--force-create','--orphan']);
  const consumesArgument=new Set(['-m','--message','-s','--strategy','-X','--strategy-option']);
  for(let i=0;i<lines.length&&refs.length<1000;i++){
    const add=(raw,kind)=>{const value=raw.replace(/[.,;]+$/,''),key=i+'\0'+value;if(valid(value)&&!seen.has(key)&&refs.length<1000){seen.add(key);refs.push({value,line:i+1,kind});}};
    // This is a text scanner, not a shell parser. Never evaluate or execute a token.
    for(const match of lines[i].matchAll(/\bgit\s+(checkout|switch|merge)\s+([^;&|]*)/gi)){
      const operation=match[1].toLowerCase(),kind=operation==='merge'?'merge':'checkout';
      let args=match[2];
      // A command wrapped in Markdown backticks ends at its closing delimiter.
      if(lines[i][match.index-1]==='`')args=args.split('`')[0];
      const tokens=[...args.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`|([^\s`"';&|]+)/g)].map(token=>token[1]??token[2]??token[3]??token[4]);
      let positional=0;
      for(let n=0;n<tokens.length;n++){
        const token=tokens[n];
        if(token==='--')break; // checkout paths after -- are not revision candidates.
        if(createsBranch.has(token)){if(tokens[n+1])add(tokens[++n],kind);continue;}
        if(consumesArgument.has(token)){n++;continue;}
        if(noArgument.has(token))continue;
        if(/^--(?:message|strategy|strategy-option|log)=/.test(token))continue;
        if(token.startsWith('-'))break; // Unknown flags may consume values; do not guess.
        if(!valid(token.replace(/[.,;]+$/,'')))break;
        if(positional>0&&!branchLike(token))break;
        add(token,kind);positional++;
        if(operation!=='merge')break;
      }
    }
    for(const match of lines[i].matchAll(/\b(checked\s+out|checking\s+out|merged|merging)\s+(?:the\s+)?(?:branch\s+)?[`"']?([A-Za-z0-9][A-Za-z0-9._\/~^-]{0,199})/gi)){
      const value=match[2].replace(/[.,;]+$/,'');if(branchLike(value))add(value,/^merg/i.test(match[1])?'merge':'checkout');
    }
    const patterns=[/\b(commit|revision|checkpoint|branch)\s*[:=]\s*[`"']?([A-Za-z0-9][A-Za-z0-9._\/~^-]{0,199})/gi,/\b(commit|revision|checkpoint|branch)\s+`([A-Za-z0-9][A-Za-z0-9._\/~^-]{0,199})`/gi,/\b(commit|revision|checkpoint)\s+([a-f0-9]{7,64})\b/gi,/`([a-f0-9]{7,64})`/gi];
    for(const pattern of patterns)for(const match of lines[i].matchAll(pattern))add(match[2]||match[1],match[2]?match[1].toLowerCase():'commit');
  }
  return refs;
}
export function readDocument(project,file,{expectedHash}={}){
  project=projectPath(project);
  if(typeof file!=='string'||!file||file.includes('\0')||!markdown(file))throw Error('Choose an existing Markdown (.md or .markdown) document');
  const requested=path.isAbsolute(file)?file:path.resolve(project,file);
  if(!path.isAbsolute(file)){const relative=path.relative(project,requested);if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('Use an explicit absolute path to select a document outside the project');}
  let canonical,stat,bytes;
  try{
    if(fs.lstatSync(requested).isSymbolicLink())throw Error('Choose a regular Markdown file, not a symbolic link');
    canonical=fs.realpathSync(requested);if(!path.isAbsolute(file)){const relative=path.relative(project,canonical);if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('Use an explicit absolute path to select a document outside the project');}stat=fs.statSync(canonical);
    if(!stat.isFile()||!markdown(canonical))throw Error('Choose a regular Markdown file');
    if(stat.size>MAX_BYTES)throw Error('Document exceeds the 1 MB limit');
    bytes=fs.readFileSync(canonical);if(bytes.length>MAX_BYTES)throw Error('Document exceeds the 1 MB limit');
  }catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')throw Error('Document was moved or deleted. Select its existing path again.');throw error;}
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(bytes.includes(0))throw Error('binary');}catch{throw Error('Document must contain regular UTF-8 text');}
  const hash=crypto.createHash('sha256').update(bytes).digest('hex');
  if(expectedHash!==undefined&&expectedHash!==hash)throw Error('Document changed since selection. Refresh it and start again.');
  const lines=text.split('\n'),sections=[];let fenced=false;
  for(let i=0;i<lines.length;i++){if(/^\s*(```|~~~)/.test(lines[i])){fenced=!fenced;continue;}if(fenced)continue;const match=/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(lines[i]);if(match){if(sections.length)sections.at(-1).endLine=i;sections.push({title:match[1],line:i+1,endLine:lines.length});}}
  if(!sections.length)sections.push({title:path.basename(canonical),line:1,endLine:lines.length});
  return {project,path:canonical,title:sections[0].title,text,hash,modifiedAt:stat.mtime.toISOString(),size:bytes.length,sections,references:references(lines)};
}
export function selectDocument(root,project,file){const doc=readDocument(project,file),target=selectedFile(root,project);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target+'.part',JSON.stringify({path:doc.path}));fs.renameSync(target+'.part',target);return doc;}
export function discoverDocuments(project){
  project=projectPath(project);const documents=[];let visited=0;
  function walk(directory,depth){if(depth>8||visited>=6000||documents.length>=200)return;let entries;try{entries=fs.readdirSync(directory,{withFileTypes:true});}catch{return;}const rank=entry=>entry.isDirectory()?4:/handover/i.test(entry.name)?0:/^readme\./i.test(entry.name)?1:2;entries.sort((a,b)=>rank(a)-rank(b)||a.name.localeCompare(b.name));
    for(const entry of entries){if(++visited>6000||documents.length>=200)break;if(entry.isSymbolicLink())continue;const file=path.join(directory,entry.name);if(entry.isDirectory()){if(!skip.has(entry.name))walk(file,depth+1);}else if(entry.isFile()&&markdown(file)){try{const doc=readDocument(project,file);documents.push({path:doc.path,title:doc.title,modifiedAt:doc.modifiedAt,size:doc.size});}catch{}}}
  }
  walk(project,0);const priority=name=>/handover/i.test(path.basename(name))?0:/^readme\./i.test(path.basename(name))?1:2;
  documents.sort((a,b)=>priority(a.path)-priority(b.path)||a.path.localeCompare(b.path));
  return {project,documents,selectedPath:null};
}
export function readDocumentRange(project,context,input={}){
  const doc=readDocument(project,context.path,{expectedHash:context.hash}),lines=doc.text.split('\n');
  const start=input.start??1,end=input.end??Math.min(lines.length,start+119);
  if(!Number.isInteger(start)||!Number.isInteger(end)||start<1||end<start||start>lines.length||end>lines.length||end-start>=300)throw Error('Choose an existing document range of at most 300 lines');
  return {path:doc.path,title:doc.title,hash:doc.hash,start,end,totalLines:lines.length,text:lines.slice(start-1,end).join('\n'),sections:doc.sections,references:doc.references.filter(ref=>ref.line>=start&&ref.line<=end),truncated:end<lines.length};
}
export function documentReferenceCandidate(project,context,value){
  const doc=readDocument(project,context.path,{expectedHash:context.hash});
  const evidence=doc.references.filter(ref=>ref.value===value);
  if(typeof value!=='string'||!evidence.length)throw Error('Choose a Git reference candidate recorded in this document');
  return {value,evidence,resolved:false,sha:null,parents:[]};
}
