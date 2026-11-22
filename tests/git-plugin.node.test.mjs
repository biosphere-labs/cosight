import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {gitRequest,gitSnapshot} from '../assets/plugins/git.js';

const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1'}}).trim();
async function fixture(t) {
  const temp=await mkdtemp(path.join(tmpdir(),'cosight-git-'));t.after(()=>rm(temp,{recursive:true,force:true}));
  const repo=path.join(temp,'repo');await mkdir(repo);git(repo,'init','-b','main');git(repo,'config','user.name','Test Author');git(repo,'config','user.email','test@example.invalid');
  const write=async(name,text)=>{await mkdir(path.dirname(path.join(repo,name)),{recursive:true});await writeFile(path.join(repo,name),text);};
  const commit=subject=>{git(repo,'add','.');git(repo,'commit','-m',subject);return git(repo,'rev-parse','HEAD');};
  return {temp,repo,write,commit};
}
test('empty and non-Git repositories have explicit behavior',async t=>{
  const {repo,temp}=await fixture(t);const result=await gitRequest(repo,'repository');assert.equal(result.empty,true);assert.equal(result.head,null);assert.equal(result.currentBranch,'main');
  assert.deepEqual(await gitRequest(repo,'history'),{commits:[],nextOffset:null,truncated:false});
  await assert.rejects(gitRequest(temp,'repository'),/not a git repository/);
  await assert.rejects(gitRequest(repo,'comparison',{base:'HEAD',head:'HEAD'}));
});
test('remote default branch remains resolvable when no local default branch exists',async t=>{
  const {repo,write,commit}=await fixture(t);await write('entry.js','export const value=1;\n');const head=commit('initial');
  git(repo,'update-ref','refs/remotes/origin/main',head);git(repo,'symbolic-ref','refs/remotes/origin/HEAD','refs/remotes/origin/main');git(repo,'checkout','--detach',head);git(repo,'branch','-D','main');
  const result=await gitRequest(repo,'repository');assert.equal(result.defaultBranch,'refs/remotes/origin/main');
  assert.equal((await gitRequest(repo,'comparison',{base:result.defaultBranch,head:'HEAD'})).head,head);
});
test('divergence, rename/delete, pagination, merge and moved refs are pinned correctly',async t=>{
  const {repo,temp,write,commit}=await fixture(t);
  await write('original.txt','original\n');await write('deleted.txt','remove me\n');const initial=commit('initial');
  git(repo,'checkout','-b','feature');git(repo,'mv','original.txt','renamed.txt');git(repo,'rm','deleted.txt');await write('feature.txt','feature\n');const feature=commit('feature change');
  git(repo,'checkout','main');await write('main.txt','main change\n');const main=commit('main change');
  const graph=await gitRequest(repo,'history');assert.equal(graph.commits.length,3);assert.ok(graph.commits.some(c=>c.sha===feature));assert.ok(graph.commits.some(c=>c.sha===main&&c.refs.includes('main')));assert.ok(!graph.commits.some(c=>c.refs.some(ref=>ref.startsWith('HEAD -> '))));
  assert.equal((await gitRequest(repo,'history',{revision:'main'})).commits.length,2);
  const graphFirst=await gitRequest(repo,'history',{limit:1}),graphRest=await gitRequest(repo,'history',{limit:10,offset:graphFirst.nextOffset});assert.equal(new Set([...graphFirst.commits,...graphRest.commits].map(c=>c.sha)).size,3);
  const before=git(repo,'status','--porcelain=v1');
  const compared=await gitRequest(repo,'comparison',{base:'main',head:'feature'});
  assert.equal(compared.base,main);assert.equal(compared.head,feature);assert.equal(compared.mergeBase,initial);
  assert.deepEqual(compared.commits.map(c=>c.subject),['feature change']);
  assert.ok(compared.files.some(f=>f.path==='renamed.txt'&&f.oldPath==='original.txt'&&f.status.startsWith('R')));
  assert.ok(compared.files.some(f=>f.path==='deleted.txt'&&f.status==='D'));
  assert.ok(!compared.files.some(f=>f.path==='main.txt'));
  const tips=await gitRequest(repo,'comparison',{base:'main',head:'feature',mode:'tips'});
  assert.ok(tips.files.some(f=>f.path==='main.txt'&&f.status==='D'));
  git(repo,'branch','-f','feature',initial);
  assert.equal((await gitRequest(repo,'source',{revision:compared.head,path:'feature.txt'})).text,'feature\n');
  await assert.rejects(gitRequest(repo,'source',{revision:'feature',path:'feature.txt'}));
  git(repo,'branch','-f','feature',feature);git(repo,'merge','--no-ff','feature','-m','merge feature');
  const merge=git(repo,'rev-parse','HEAD');const history=await gitRequest(repo,'history',{limit:1});
  assert.equal(history.commits[0].sha,merge);assert.equal(history.commits[0].parents.length,2);assert.equal(history.truncated,true);assert.equal(history.nextOffset,1);
  assert.equal((await gitRequest(repo,'history',{offset:1,limit:10})).commits.length,3);
  await write('feature.txt','dirty worktree\n');await write('untracked.txt','untracked\n');
  const repoInfo=await gitRequest(repo,'repository');assert.equal(repoInfo.dirty,true);assert.equal(repoInfo.currentBranch,'main');assert.equal(repoInfo.defaultBranch,'main');assert.ok(repoInfo.refs.some(r=>r.name==='refs/heads/feature'&&r.sha===feature));
  const status=git(repo,'status','--porcelain=v1');const snapshot=await gitSnapshot(repo,merge,path.join(temp,'snapshot'));
  assert.equal(snapshot.revision,merge);assert.equal(await readFile(path.join(snapshot.directory,'feature.txt'),'utf8'),'feature\n');
  assert.equal(git(repo,'rev-parse','HEAD'),merge);assert.equal(git(repo,'status','--porcelain=v1'),status);assert.equal(await readFile(path.join(repo,'feature.txt'),'utf8'),'dirty worktree\n');assert.equal(before,'');
  git(repo,'checkout','--detach',feature);assert.equal((await gitRequest(repo,'repository')).currentBranch,null);
});
test('snapshot omits unsafe content and source uses committed blobs',async t=>{
  const {repo,temp,write,commit}=await fixture(t);await write('safe.txt','committed\n');await write('binary.dat',Buffer.from([0,1,2]));await write('large.txt','x'.repeat(100));await symlink('/etc/passwd',path.join(repo,'outside'));const sha=commit('files');
  // A gitlink entry exercises submodule omission without touching the network.
  git(repo,'update-index','--add','--cacheinfo',`160000,${sha},nested`);git(repo,'commit','-m','gitlink');const head=git(repo,'rev-parse','HEAD');
  await write('safe.txt','dirty\n');
  const snap=await gitSnapshot(repo,head,path.join(temp,'snapshot'),{maxFileBytes:50});
  assert.equal(snap.files,1);assert.equal(snap.omitted.length,4);assert.ok(snap.omitted.some(x=>x==='outside: symlink'));assert.ok(snap.omitted.some(x=>x==='nested: submodule or unsupported entry'));assert.ok(snap.omitted.some(x=>x==='binary.dat: binary file'));assert.ok(snap.omitted.some(x=>x==='large.txt: oversized file'));
  assert.equal((await gitRequest(repo,'source',{path:'safe.txt',revision:head})).text,'committed\n');assert.equal((await gitRequest(repo,'source',{path:'binary.dat',revision:head})).binary,true);
  await assert.rejects(gitRequest(repo,'source',{path:'outside',revision:head}),/regular tracked file/);
  await assert.rejects(gitRequest(repo,'source',{path:'large.txt',revision:head},{maxFileBytes:50}),/size limit/);
});
test('rejects traversal, options, existing and repository destinations; supports cancellation and visible truncation',async t=>{
  const {repo,temp,write,commit}=await fixture(t);await write('safe.txt','a'.repeat(500));const head=commit('initial');await write('safe.txt','b'.repeat(500));commit('change');
  for(const name of ['../safe.txt','/etc/passwd','a/../../b','a\\b','./safe.txt','C:/secret']) await assert.rejects(gitRequest(repo,'source',{path:name}));
  for(const revision of ['--help','HEAD:safe.txt','HEAD\n'])await assert.rejects(gitRequest(repo,'source',{revision,path:'safe.txt'}),/Invalid Git revision/);
  await assert.rejects(gitSnapshot(repo,head,repo),/outside/);await assert.rejects(gitSnapshot(repo,head,path.join(repo,'snapshot')),/outside/);
  const alias=path.join(temp,'alias');await symlink(repo,alias);await assert.rejects(gitSnapshot(repo,head,path.join(alias,'snapshot')),/outside/);
  const existing=path.join(temp,'existing');await mkdir(existing);await assert.rejects(gitSnapshot(repo,head,existing),/EEXIST/);
  const patch=await gitRequest(repo,'comparison',{base:head,head:'HEAD'},{maxPatchBytes:32});assert.equal(patch.truncated,true);assert.ok(patch.warnings.some(x=>x.includes('Patch truncated')));assert.equal(Buffer.byteLength(patch.patch),32);
  const controller=new AbortController();controller.abort();await assert.rejects(gitRequest(repo,'repository',{}, {signal:controller.signal}));
  await assert.rejects(gitRequest(repo,'history',{limit:-1}));await assert.rejects(gitRequest(repo,'history',{limit:0}));await assert.rejects(gitRequest(repo,'comparison',{base:head,head:'HEAD',mode:'unknown'}));
});
test('shallow clone warns and refuses unavailable merge bases without fetching',async t=>{
  const {repo,temp,write,commit}=await fixture(t);await write('a','1');commit('first');await write('a','2');commit('second');await write('a','3');commit('third');
  const clone=path.join(temp,'shallow');git(temp,'clone','--depth=2',`file://${repo}`,clone);
  const state=await gitRequest(clone,'repository');assert.equal(state.shallow,true);
  const comparison=await gitRequest(clone,'comparison',{base:'HEAD~1',head:'HEAD'});assert.ok(comparison.warnings.some(x=>x.includes('shallow')));
  await assert.rejects(gitRequest(clone,'source',{revision:'HEAD~2',path:'a'}));assert.equal(git(clone,'rev-list','--count','HEAD'),'2');
});
test('multiple merge bases are an explicit error',async t=>{
  const {repo,write,commit}=await fixture(t);await write('root','root');const root=commit('root');
  // Construct a criss-cross graph using commit-tree, with two incomparable common ancestors.
  const tree=git(repo,'rev-parse',`${root}^{tree}`);
  const one=git(repo,'commit-tree',tree,'-p',root,'-m','one'),two=git(repo,'commit-tree',tree,'-p',root,'-m','two');
  const left=git(repo,'commit-tree',tree,'-p',one,'-p',two,'-m','left'),right=git(repo,'commit-tree',tree,'-p',two,'-p',one,'-m','right');
  await assert.rejects(gitRequest(repo,'comparison',{base:left,head:right}),/Multiple merge bases/);
});
test('missing Git is actionable',async t=>{
  const {repo,temp}=await fixture(t);const saved=process.env.PATH;
  try {process.env.PATH=temp;await assert.rejects(gitRequest(repo,'repository'),/Git is not installed or is unavailable/);}
  finally {process.env.PATH=saved;}
});
