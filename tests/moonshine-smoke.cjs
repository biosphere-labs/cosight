// Real WASM models in Chromium; fake microphone plays a public Moonshine fixture.
const {chromium}=require('playwright');const {fork}=require('node:child_process');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve('temp/moonshine-smoke');fs.mkdirSync(root,{recursive:true});
 fs.writeFileSync(path.join(root,'setup.json'),JSON.stringify({configured:true}));
 fs.writeFileSync(path.join(root,'tour.json'),JSON.stringify({project:root,tourId:'t-moonshine',v:1,phase:'done',question:'Voice integration',plan:[],stops:[],asides:[]}));
 const child=fork(path.resolve('assets/tour-server.js'),[root,'0'],{silent:true,env:{...process.env,KOKORO_ENSURE:'',KOKORO_URL:'http://127.0.0.1:1'}});
 let browser;
 try{
  const port=await new Promise((resolve,reject)=>{child.once('message',m=>resolve(m.port));child.once('error',reject);child.once('exit',c=>reject(Error('Server exited '+c)));});
  browser=await chromium.launchPersistentContext(path.join(root,'profile'),{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--use-file-for-fake-audio-capture='+path.resolve('temp/moonshine-mic.wav')]});
  const page=await browser.newPage();page.setDefaultTimeout(180000);page.on('pageerror',e=>console.error('PAGE:',e.message));
  await page.addInitScript(()=>{localStorage.setItem('cosight:voiceEngine','moonshine');localStorage.setItem('cosight:micModel','TinyStreaming');});
  await page.goto(`http://127.0.0.1:${port}/`);await page.waitForFunction(()=>window.CoSightSpeech);
  const timer=setInterval(async()=>{try{console.log('status:',await page.locator('#micStatus').textContent());}catch{}},20000);
  try{
   await page.waitForFunction(()=>window.CoSightHome);await page.locator('#homeRecent button').filter({hasText:root}).click();
   const synthesis=await page.evaluate(async()=>{
    const started=performance.now();const url=await CoSightSpeech.prepare('Welcome to CoSight. Follow the code with a guide.',m=>console.log(m));
    const bytes=await (await fetch(url)).arrayBuffer();const audio=document.getElementById('au');audio.src=url;await audio.play();
    await new Promise(resolve=>audio.addEventListener('ended',resolve,{once:true}));
    return {bytes:bytes.byteLength,seconds:audio.duration,elapsedMs:Math.round(performance.now()-started)};
   });
   assert.ok(synthesis.bytes>10000);assert.ok(synthesis.seconds>1);console.log('Real Moonshine narration:',JSON.stringify(synthesis));
   fs.mkdirSync(path.join(root,'files'),{recursive:true});fs.writeFileSync(path.join(root,'files','voice.txt'),'function welcome() { return "hello"; }');
   const uninterrupted=await page.evaluate(()=>{CoSightHome.hide();apply({...doc,tourId:'t-moonshine-playback',phase:'done',plan:[{n:1,title:'Voice'}],stops:[{id:'voice-one',n:1,title:'Voice',say:'Welcome to CoSight. Follow the code with a guide.',file:'voice.js',fileUrl:'files/voice.txt',start:1,end:1,highlight:[1]}]});const before=speechAttempt;apply({...doc,serverV:99,stops:doc.stops.map(stop=>({...stop,audio:'audio/server-audio-arrived.mp3'}))});return before===speechAttempt;});
   assert.equal(uninterrupted,true,'Server audio update interrupted local voice preparation');
   assert.equal(await page.evaluate(()=>paused),true);await page.locator('#voicePreparation').waitFor({state:'hidden'});await page.locator('#bPlay').click();
   await page.waitForFunction(()=>au.currentTime>0&&!au.paused&&au.src.startsWith('blob:'));
   console.log('Moonshine plays through the actual tour audio controls');

   await page.locator('#bHome').click();await page.locator('#askin').fill('Please explain:');await page.locator('#bMic').click();
   await page.waitForFunction(()=>document.getElementById('micStatus').textContent.startsWith('Listening locally'),{},{timeout:180000});
   await page.waitForFunction(()=>document.getElementById('askin').value.length>55,{},{timeout:60000});
   await page.locator('#bMic').click();await page.waitForFunction(()=>!CoSightSpeech.recording());
   const transcript=await page.locator('#askin').inputValue();assert.ok(transcript.startsWith('Please explain:'));assert.match(transcript,/times|wisdom|foolishness|season/i);
   assert.equal(fs.existsSync(path.join(root,'requests.jsonl')),false);assert.equal(await page.locator('#bSend').isEnabled(),true);
   console.log('Real microphone transcription:',transcript);
   await page.evaluate(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Denied by test','NotAllowedError');};});
   await page.locator('#bMic').click();await page.waitForFunction(()=>document.getElementById('micStatus').textContent.includes('permission was denied'));
   assert.equal(await page.locator('#askin').inputValue(),transcript);assert.equal(await page.locator('#bSend').isEnabled(),true);
   await page.screenshot({path:'temp/moonshine-smoke.png'});
   // Reload, block remote downloads, and synthesize again from the persisted model cache.
   await browser.route(/^https:\/\//,route=>route.abort());await page.reload();await page.waitForFunction(()=>window.CoSightSpeech);
   const offline=await page.evaluate(async()=>{const url=await CoSightSpeech.prepare('Models are cached for offline use.');return (await (await fetch(url)).arrayBuffer()).byteLength;});assert.ok(offline>10000);
   await page.waitForFunction(()=>window.CoSightHome);await page.locator('#homeRecent button').filter({hasText:root}).click();await page.locator('#bMic').click();
   await page.waitForFunction(()=>document.getElementById('micStatus').textContent.startsWith('Listening locally'));
   await page.waitForFunction(()=>document.getElementById('askin').value.length>15,{},{timeout:60000});
   await page.locator('#bMic').click();await page.waitForFunction(()=>!CoSightSpeech.recording());

   const receipt={synthesis,transcript,deniedPermissionPreservedDraft:true,noAutomaticSend:true,offlineTtsBytes:offline,offlineDictation:true,actualTourPlayback:true};
   fs.mkdirSync('artifacts/verification',{recursive:true});fs.writeFileSync('artifacts/verification/moonshine-receipt.json',JSON.stringify(receipt,null,2));console.log('Moonshine browser checks passed');
  }finally{clearInterval(timer);}
 }finally{await browser?.close();child.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
