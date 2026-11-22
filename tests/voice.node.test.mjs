import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../assets/index.html',import.meta.url),'utf8');
function harness(){
  let calls=0, fail=true, cancels=0;
  const nodes=new Map();
  const node=id=>{if(!nodes.has(id))nodes.set(id,{className:'',textContent:'',innerHTML:'',disabled:false});return nodes.get(id);};
  const au=Object.assign(node('au'),{pause(){},play(){calls++; return fail?Promise.reject(Object.assign(Error('blocked'),{name:'NotAllowedError'})):Promise.resolve();},addEventListener(){}});
  const entry={id:'one',say:'Hello.',audio:'audio/hello.mp3',n:1};
  const ctx={resumeAt:null,console,setTimeout,clearTimeout,setInterval,clearInterval,$:node,curEntry:()=>entry,muted:false,paused:false,editing:false,rate:1,doc:{tts:{state:'ready'}},cueStart(){},cueHalt(){},cueEnd(){},cueTick(){},window:{speechSynthesis:{cancel(){cancels++;},resume(){},speak(){}}},store(){},drawHeader(){},flash(){},autoplay:true,cur:{n:1},waitingFor:0,heldNext:0,SpeechSynthesisUtterance:function(text){this.text=text;}};
  vm.createContext(ctx);
  const start=html.indexOf('var voiceBlocked=false');
  const end=html.indexOf('/* ---------- buttons ---------- */',start);
  vm.runInContext(html.slice(start,end),ctx);
  return {ctx,entry,au,node,calls:()=>calls,allow(){fail=false;}};
}
test('blocked initial voice exposes one-click recovery without toggling mute',async()=>{
  const h=harness(); h.ctx.speak(h.entry); await new Promise(r=>setImmediate(r));
  assert.equal(h.ctx.voiceBlocked,true); assert.equal(h.node('unmute').className,'on');
  assert.match(h.node('voice').textContent,/Press Play/); assert.equal(h.ctx.muted,false);
  h.allow(); h.ctx.speak(h.entry); await new Promise(r=>setImmediate(r));
  assert.equal(h.ctx.voiceBlocked,false); assert.equal(h.node('unmute').className,''); assert.equal(h.calls(),2);
});
test('late rejection from superseded playback cannot block the new playback',async()=>{
  const h=harness(); h.ctx.speak(h.entry); h.allow(); h.ctx.speak(h.entry);
  await new Promise(r=>setImmediate(r));
  assert.equal(h.ctx.voiceBlocked,false); assert.equal(h.ctx.speakingStarted,true);
});
test('browser fallback resumes a paused speech engine and clears stale media source',()=>{
  const h=harness(); h.ctx.speakSrc='audio/old.mp3'; h.ctx.synth(h.entry);
  assert.equal(h.ctx.speakSrc,''); assert.equal(h.ctx.speakingStarted,true);
});
test('spoken identifiers split camelCase and acronym boundaries without mutating display text',async()=>{
  await import('../assets/narration-text.js');
  const text='BuildStrategy uses HTTPServer and getURLValue in RxJS.';
  assert.equal(globalThis.CoSightNarrationText(text),'build strategy uses H T T P server and get U R L value in rx J S.');
  assert.equal(text,'BuildStrategy uses HTTPServer and getURLValue in RxJS.');
});
test('pause cancels pending speech and invalidates late preparation callbacks',()=>{
  const h=harness();
  const start=html.indexOf('function pauseNow(){'),end=html.indexOf('function resumeNow(){',start);
  vm.runInContext(html.slice(start,end),h.ctx);
  h.ctx.speaking='one';h.ctx.speakingStarted=false;h.ctx.waitingFor=2;h.ctx.heldNext=3;
  const attempt=h.ctx.speechAttempt;h.ctx.pauseNow();
  assert.equal(h.ctx.paused,true);assert.equal(h.ctx.autoplay,false);
  assert.equal(h.ctx.waitingFor,0);assert.equal(h.ctx.heldNext,0);
  assert.equal(h.ctx.speaking,null);assert.ok(h.ctx.speechAttempt>attempt);
});
test('restoring voice-on preference never unpauses the tour',()=>{
 const h=harness();const start=html.indexOf('function setMuted(on,say){'),end=html.indexOf('/* ---------- buttons ---------- */',start);
 vm.runInContext(html.slice(start,end),h.ctx);h.ctx.paused=true;h.ctx.autoplay=false;
 h.ctx.setMuted(false,false);assert.equal(h.ctx.paused,true);assert.equal(h.ctx.autoplay,false);assert.equal(h.calls(),0);
});
