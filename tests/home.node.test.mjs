import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fork} from 'node:child_process';
import {projectOverview} from '../assets/project-home.js';

function temporary(t){fs.mkdirSync('temp',{recursive:true});const root=fs.mkdtempSync(path.resolve('temp/home-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('project overview reads README and manifest without Git, ignores linked README outside project, and handles missing files',t=>{
  const project=temporary(t);
  fs.writeFileSync(path.join(project,'README.md'),'# River\n\n![badge](https://example.com/image)\n\nRiver processes local data.\n\nIt connects inputs to reports.\n');
  fs.writeFileSync(path.join(project,'package.json'),JSON.stringify({name:'river-internal',description:'A local data explorer'}));
  const result=projectOverview(project);
  assert.equal(result.name,'River');assert.equal(result.description,'A local data explorer');assert.equal(result.paragraphs[0],'River processes local data.');assert.equal(result.readme.file,'README.md');
  assert.equal(fs.existsSync(path.join(project,'.git')),false);
  fs.unlinkSync(path.join(project,'README.md'));assert.equal(projectOverview(project).readme,null);
  const outside=path.join(temporary(t),'private.md');fs.writeFileSync(outside,'Do not show this');fs.symlinkSync(outside,path.join(project,'README.md'));assert.equal(projectOverview(project).readme,null);
  assert.ok(projectOverview(path.join(project,'missing')).error);
});
test('home endpoint exposes the active project and saved tours while experimental routes are off by default',async t=>{
  const root=temporary(t),project=path.join(root,'source');fs.mkdirSync(project);fs.writeFileSync(path.join(project,'README.md'),'# Project home\n\nA useful overview.');
  fs.writeFileSync(path.join(root,'tour.json'),JSON.stringify({project,tourId:'t-1',v:1,question:'Saved question',stops:[{id:'s1',n:1,say:'Hello'}],asides:[],plan:[],phase:'done'}));
  const server=fork(new URL('../assets/tour-server.js',import.meta.url),[root,'0'],{silent:true,env:{...process.env,COSIGHT_EXPERIMENTAL_PLUGINS:'0',KOKORO_ENSURE:''}});t.after(()=>server.kill());
  const port=await new Promise((resolve,reject)=>{server.once('message',m=>resolve(m.port));server.once('error',reject);server.once('exit',code=>reject(Error('Server exited '+code)));});
  const base='http://127.0.0.1:'+port;
  const home=await(await fetch(base+'/home')).json();assert.equal(home.project,project);assert.equal(home.overview.name,'Project home');assert.equal(home.tours[0].question,'Saved question');assert.equal(home.features.analysisPlugins,false);
  assert.equal((await fetch(base+'/analysis')).status,404);
  assert.equal((await fetch(base+'/home.js')).status,200);assert.equal((await fetch(base+'/home.css')).status,200);
});
