import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
test('tour audio prefetch deduplicates playback, keeps worker through cancellation and reuses persistent cache',async()=>{
 const disk=new Map(),workers=[],messages=[];
 const context={console,setTimeout,clearTimeout,Blob,Response,TextEncoder,URL,crypto:webcrypto,location:{href:'http://localhost/'},load:(_k,d)=>d,CoSightNarrationText:t=>t,document:{createElement:()=>({hidden:true,setAttribute(){},querySelector(){return {textContent:'',onclick:null,removeAttribute(){}};}}),body:{append(){},classList:{contains:()=>false}}},curEntry:()=>({id:'one'}),caches:{open:async()=>({match:async k=>disk.get(k)?.clone(),put:async(k,v)=>disk.set(k,v.clone())})},Worker:class{constructor(){workers.push(this)}postMessage(m){messages.push(m);setTimeout(()=>this.onmessage({data:{id:m.id,type:'audio',audio:new Float32Array([0,.1]),sampleRate:16000}}),5)}terminate(){throw Error('Worker should remain warm')}}};
 context.doc={stops:[{id:'one',say:'First'},{id:'two',say:'Second'}]};context.window=context;
 const source=fs.readFileSync('assets/speech.js','utf8');vm.createContext(context);vm.runInContext(source.slice(source.indexOf('(function(){')+12,source.indexOf('  async function loadMic(){'))+'\nglobalThis.api={prepare,prefetchTour,cancelSpeech};',context);
 context.api.prefetchTour();context.api.cancelSpeech();await context.api.prepare('First');await context.api.prepare('Second');
 assert.equal(workers.length,1);assert.equal(messages.length,2);assert.equal(disk.size,2);
 vm.runInContext('urls.clear()',context);await context.api.prepare('First');assert.equal(messages.length,2);
});
