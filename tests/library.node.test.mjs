import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { library } from '../assets/library.js';
import { fork } from 'node:child_process';
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(),'cosight-test-'));
const doc = (project,id,v=1) => ({project,tourId:id,v,question:'Trace a request',phase:'done',stops:[{id:'a',n:1,say:'Hello'}],asides:[],plan:[]});
test('project saves stay isolated and preset edits do not change project copies', t => {
  const root=temp(); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const store=library(root);
  store.savePreset('Overview','Trace the request');
  store.saveSettings('/a',{instructions:store.presets()[0].instructions,preset:'Overview'});
  store.saveSettings('/b',{instructions:'Explain performance'});
  store.savePreset('Overview','Different instructions');
  assert.equal(library(root).settings('/a').instructions,'Trace the request');
  assert.equal(store.settings('/b').instructions,'Explain performance');
  assert.equal(store.settings('/c').instructions,'');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'project-instructions.json')))['/a'],'Trace the request');
});
test('history survives restart, separates projects, updates snapshots, and imports old archives', t => {
  const root=temp(); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const store=library(root);
  store.snapshot(doc('/a','t-10')); store.snapshot(doc('/b','t-20')); store.snapshot(doc('/a','t-10',3));
  fs.writeFileSync(path.join(root,'tours','legacy.json'),JSON.stringify(doc('/a','t-5')));
  fs.writeFileSync(path.join(root,'tours','broken.json'),'{');
  const restarted=library(root);
  assert.equal(restarted.history('/a').length,2);
  assert.equal(restarted.history('/a')[0].v,3);
  assert.equal(restarted.history('').length,3);
});
test('HTTP API saves settings, validates requests, and snapshots live tours without replacing live file', async t => {
  const root=temp(); const child=fork(new URL('../assets/tour-server.js',import.meta.url),[root,'0'],{env:{...process.env,KOKORO_ENSURE:'',KOKORO_URL:'http://127.0.0.1:1'},silent:true});
  t.after(()=>{child.kill(); fs.rmSync(root,{recursive:true,force:true});});
  const port=await new Promise((resolve,reject)=>{child.once('message',m=>resolve(m.port)); child.once('error',reject); child.once('exit',code=>reject(Error('server exited '+code))); setTimeout(()=>reject(Error('server startup timed out')),5000).unref();});
  const url=`http://127.0.0.1:${port}`;
  const post=(p,value)=>fetch(url+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
  assert.equal((await post('/settings',{project:'/a',instructions:'Trace it'})).status,200);
  assert.equal((await (await fetch(url+'/library?project=/a')).json()).settings.instructions,'Trace it');
  fs.writeFileSync(path.join(root,'tour.json'),JSON.stringify(doc('/a','t-30')));
  let body;
  for(let i=0;i<50;i++){body=await (await fetch(url+'/library?project=/a')).json(); if(body.tours.length) break; await new Promise(r=>setTimeout(r,30));}
  assert.equal(body.tours[0].tourId,'t-30');
  assert.equal((await post('/request',{kind:'tour',project:'/b',text:'Overview'})).status,409);
  assert.equal((await post('/request',{kind:'tour',project:'/a',text:'Overview'})).status,200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'requests.jsonl'),'utf8')).project,'/a');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'tour.json'),'utf8')).tourId,'t-30');
});

test('first-run setup completes after saving a project and survives a new library instance',t=>{
  const root=temp();t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  assert.equal(library(root).setupStatus().configured,false);
  library(root).saveSettings('/project',{instructions:'Trace a request'});
  assert.equal(library(root).setupStatus().configured,true);
});
