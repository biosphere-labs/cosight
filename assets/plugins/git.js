import {spawn} from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';

const MAX_OUTPUT = 16 * 1024 * 1024;
const MAX_FILE = 1024 * 1024;
function aborted(signal) { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : Error('Git operation cancelled'); }
function run(cwd, args, options = {}) {
  aborted(options.signal);
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-pager', '-c', 'core.quotePath=false', '-c', 'core.fsmonitor=false', ...args], {
      cwd, shell: false, windowsHide: true,
      env: {...process.env, GIT_OPTIONAL_LOCKS:'0', GIT_TERMINAL_PROMPT:'0', GIT_NO_REPLACE_OBJECTS:'1'},
      stdio:['ignore','pipe','pipe'],
    });
    const chunks=[]; let bytes=0, stderr='', truncated=false, failure;
    const limit=options.outputLimit ?? MAX_OUTPUT;
    child.stdout.on('data', chunk => {
      const remaining=Math.max(0,limit-bytes);
      if (remaining) chunks.push(chunk.subarray(0,remaining));
      bytes+=Math.min(chunk.length,remaining);
      if(chunk.length>remaining) { truncated=true; if(!options.allowTruncated) {failure=Error('Git output exceeded safety limit');child.kill();} }
    });
    child.stderr.on('data', chunk => { if(stderr.length<8192) stderr+=chunk.toString().slice(0,8192-stderr.length); });
    const cancel=()=>{failure=Error('Git operation cancelled');child.kill();};
    options.signal?.addEventListener('abort',cancel,{once:true});
    const timer=setTimeout(()=>{failure=Error('Git operation timed out');child.kill();},options.timeoutMs ?? 30000);
    child.on('error',error=>{failure=error.code==='ENOENT'?Error('Git is not installed or is unavailable'):error;});
    child.on('close',code=>{
      clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);
      if(failure) reject(failure);
      else if(code!==0&&!options.allowFailure) reject(Error(stderr.trim()||`Git exited with status ${code}`));
      else resolve({buffer:Buffer.concat(chunks),text:Buffer.concat(chunks).toString('utf8'),code,truncated});
    });
    if(options.signal?.aborted) cancel();
  });
}
function revision(value) {
  if(typeof value!=='string'||!value||value.startsWith('-')||/[\s\x00-\x1f\x7f:]/.test(value)) throw Error('Invalid Git revision');
  return value;
}
function filePath(value) {
  if(typeof value!=='string'||!value||value.includes('\\')||value.includes('\0')||path.posix.isAbsolute(value)||value.split('/').some(p=>!p||p==='.'||p==='..')||/^[a-z]:/i.test(value)) throw Error('Invalid repository path');
  return value;
}
async function context(project, options) {
  if(typeof project!=='string'||!project) throw Error('A project directory is required');
  const root=(await run(project,['rev-parse','--show-toplevel'],options)).text.trim();
  return {root,project:path.resolve(project)};
}
async function resolve(root, ref, options) {
  const sha=(await run(root,['rev-parse','--verify','--end-of-options',`${revision(ref)}^{commit}`],options)).text.trim();
  if(!/^[a-f0-9]{40,64}$/.test(sha)) throw Error('Git revision did not resolve to a commit');
  return sha;
}
async function repository(ctx,options) {
  const {root,project}=ctx;
  const headResult=await run(root,['rev-parse','--verify','HEAD^{commit}'],{...options,allowFailure:true});
  const branch=await run(root,['symbolic-ref','--quiet','--short','HEAD'],{...options,allowFailure:true});
  const remoteDefault=await run(root,['symbolic-ref','--quiet','--short','refs/remotes/origin/HEAD'],{...options,allowFailure:true});
  const refs=(await run(root,['for-each-ref','--format=%(refname)%00%(objectname)','refs/heads','refs/remotes','refs/tags'],options)).text.trim().split('\n').filter(Boolean).map(line=>{
    const [name,sha]=line.split('\0');return {name,sha,kind:name.startsWith('refs/heads/')?'branch':name.startsWith('refs/remotes/')?'remote':'tag'};
  });
  const remoteName=remoteDefault.code===0?remoteDefault.text.trim():null;
  const localName=remoteName?.replace(/^origin\//,'');
  const defaultBranch=remoteName?(refs.some(ref=>ref.name===`refs/heads/${localName}`)?localName:`refs/remotes/${remoteName}`):['main','master'].find(name=>refs.some(ref=>ref.name===`refs/heads/${name}`))??null;
  return {root,project,head:headResult.code===0?headResult.text.trim():null,currentBranch:branch.code===0?branch.text.trim():null,defaultBranch,refs,dirty:!!(await run(root,['status','--porcelain=v1','-z','--untracked-files=normal'],options)).buffer.length,shallow:(await run(root,['rev-parse','--is-shallow-repository'],options)).text.trim()==='true',empty:headResult.code!==0};
}
function page(value,fallback,max) { if(value===undefined)return fallback; if(!Number.isSafeInteger(value)||value<0||value>max)throw Error('Invalid history pagination');return value; }
async function commits(root,range,limit,offset,options) {
  const result=await run(root,['log','--topo-order',`--max-count=${limit+1}`,`--skip=${offset}`,'--format=%H%x00%P%x00%s%x00%an%x00%aI%x00%D%x00',...(range?[range]:['--all']),'--'],options);
  const fields=result.text.split('\0');const rows=[];
  for(let i=0;i+5<fields.length;i+=6) rows.push({sha:fields[i].trim(),parents:fields[i+1].split(' ').filter(Boolean),subject:fields[i+2],author:fields[i+3],date:fields[i+4],refs:fields[i+5].split(', ').filter(Boolean).map(ref=>ref.replace(/^HEAD -> /,'').replace(/^tag: /,''))});
  return {commits:rows.slice(0,limit),truncated:rows.length>limit};
}
function filesFrom(buffer) {
  const fields=buffer.toString('utf8').split('\0');const files=[];
  for(let i=0;i<fields.length&&fields[i];) { const code=fields[i++];const first=fields[i++];const renamed=/^[RC]/.test(code);files.push({path:renamed?fields[i++]:first,oldPath:renamed?first:null,status:code}); }
  return files;
}
function isBinary(buffer) { if(buffer.includes(0))return true; try{new TextDecoder('utf-8',{fatal:true}).decode(buffer);return false;}catch{return true;} }
async function tree(root,sha,options) {
  const {buffer}=await run(root,['ls-tree','-r','-z','-l',sha],options);
  return buffer.toString('utf8').split('\0').filter(Boolean).map(row=>{const tab=row.indexOf('\t');const [mode,type,oid,size]=row.slice(0,tab).trim().split(/\s+/);return {mode,type,oid,size:Number(size),path:row.slice(tab+1)};});
}
export async function gitRequest(project,operation,input={},options={}) {
  if(!['repository','history','comparison','source'].includes(operation))throw Error('Unknown Git operation');
  const ctx=await context(project,options);const {root}=ctx;
  if(operation==='repository')return repository(ctx,options);
  if(operation==='history') {
    const offset=page(input.offset,0,1000000),limit=page(input.limit,50,500);
    if(limit===0)throw Error('History limit must be positive');
    const repo=await repository(ctx,options);if(repo.empty&&!repo.refs.length)return {commits:[],nextOffset:null,truncated:false};
    const sha=input.revision===undefined?null:await resolve(root,input.revision,options);
    const result=await commits(root,sha,limit,offset,options);
    return {...result,nextOffset:result.truncated?offset+result.commits.length:null};
  }
  if(operation==='comparison') {
    const mode=input.mode??'feature';if(!['feature','tips'].includes(mode))throw Error('Invalid comparison mode');
    const base=await resolve(root,input.base,options),head=await resolve(root,input.head,options);
    const merge=await run(root,['merge-base','--all',base,head],{...options,allowFailure:true});
    const bases=merge.text.trim().split('\n').filter(Boolean);
    if(bases.length>1)throw Error('Multiple merge bases: choose an explicit comparison base');
    if(!bases.length)throw Error('No merge base is available; histories may be unrelated or shallow');
    const mergeBase=bases[0],start=mode==='feature'?mergeBase:base;
    const history=await commits(root,`${start}..${head}`,500,0,options);
    const files=filesFrom((await run(root,['diff','--no-ext-diff','--no-textconv','--name-status','-z','--find-renames',start,head,'--'],options)).buffer);
    const patch=await run(root,['diff','--no-ext-diff','--no-textconv','--no-color','--find-renames',start,head,'--'],{...options,outputLimit:options.maxPatchBytes??MAX_FILE,allowTruncated:true});
    const shallow=(await run(root,['rev-parse','--is-shallow-repository'],options)).text.trim()==='true';
    const warnings=[];if(shallow)warnings.push('Repository is shallow; history and merge-base evidence may be incomplete.');if(history.truncated)warnings.push('Commit list truncated at 500 commits.');if(patch.truncated)warnings.push('Patch truncated at the output byte limit.');
    return {repository:root,base,head,mergeBase,mode,commits:history.commits,files,patch:patch.text,truncated:history.truncated||patch.truncated,warnings};
  }
  const sha=await resolve(root,input.revision??'HEAD',options),name=filePath(input.path);
  const entry=(await tree(root,sha,options)).find(item=>item.path===name);
  if(!entry||entry.type!=='blob'||!['100644','100755'].includes(entry.mode))throw Error('Requested path is not a regular tracked file at this revision');
  if(entry.size>(options.maxFileBytes??MAX_FILE))throw Error('Source file exceeds size limit');
  const buffer=(await run(root,['cat-file','blob',entry.oid],options)).buffer,binary=isBinary(buffer);
  return {path:name,revision:sha,text:binary?'':buffer.toString('utf8'),binary};
}
export async function gitSnapshot(project,revisionValue,destination,options={}) {
  const {root}=await context(project,options),sha=await resolve(root,revisionValue,options);
  if(typeof destination!=='string'||!destination)throw Error('A snapshot destination is required');
  const requested=path.resolve(destination);
  // Resolve the parent before creating anything, rejecting aliases into the worktree.
  const parent=await fs.realpath(path.dirname(requested)),directory=path.join(parent,path.basename(requested));
  const realRoot=await fs.realpath(root);
  if(directory===realRoot||directory.startsWith(realRoot+path.sep))throw Error('Snapshot destination must be outside the repository');
  const entries=await tree(root,sha,options);aborted(options.signal);
  // Exclusive creation prevents pre-existing symlinks and files from being followed.
  await fs.mkdir(directory);
  const omitted=[];let files=0,total=0;
  try {
    for(const entry of entries) {
      aborted(options.signal);
      let name;try{name=filePath(entry.path);}catch{omitted.push(`${entry.path}: unsafe path`);continue;}
      if(name.split('/').some(part=>part.toLowerCase()==='.git')){omitted.push(`${name}: Git metadata path`);continue;}
      if(entry.mode==='120000'){omitted.push(`${name}: symlink`);continue;}
      if(entry.type!=='blob'){omitted.push(`${name}: submodule or unsupported entry`);continue;}
      if(entry.size>(options.maxFileBytes??MAX_FILE)){omitted.push(`${name}: oversized file`);continue;}
      if(files>=(options.maxFiles??10000)||total+entry.size>(options.maxSnapshotBytes??50*MAX_FILE)){omitted.push(`${name}: snapshot size limit`);continue;}
      const buffer=(await run(root,['cat-file','blob',entry.oid],options)).buffer;
      if(isBinary(buffer)){omitted.push(`${name}: binary file`);continue;}
      const target=path.join(directory,...name.split('/'));
      await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,buffer,{flag:'wx',mode:0o644});files++;total+=buffer.length;
    }
    return {directory,revision:sha,files,omitted};
  } catch(error) {await fs.rm(directory,{recursive:true,force:true});throw error;}
}
