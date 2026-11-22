/* On-device dictation and narration. The question remains editable until Send. */
(function(){
  var worker=null,pending=null,sequence=0,urls=new Map();
  var mic=null,micLoad=null,recording=false,loadingMic=false,stopping=false,cancelStart=false;
  var micAttempt=0,sessionProject='',sessionTour='';
  var base='',finalLines=new Map(),partial='';
  var engine=load('cosight:voiceEngine','moonshine'),voice=load('cosight:moonshineVoice','kokoro_bf_emma');
  var model=load('cosight:micModel','SmallStreaming');
  function status(text){$('micStatus').textContent=text;}
  function setMicState(){
    $('bMic').classList.toggle('recording',recording||loadingMic);
    $('bMic').setAttribute('aria-pressed',String(recording||loadingMic));
    $('bMic').title=recording?'Stop dictation':loadingMic?'Cancel microphone preparation':'Speak your question';
    $('bMic').setAttribute('aria-label',$('bMic').title);
    $('bSend').disabled=recording||loadingMic||stopping||!!window.CoSightHome?.busy();
    $('askin').readOnly=recording||loadingMic||stopping;
  }
  function renderTranscript(){
    var words=[base,...finalLines.values(),partial].filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
    $('askin').value=words;$('askin').dispatchEvent(new Event('input',{bubbles:true}));
  }
  function wav(audio,sampleRate){
    var data=new ArrayBuffer(44+audio.length*2),view=new DataView(data);
    function str(at,s){for(var i=0;i<s.length;i++)view.setUint8(at+i,s.charCodeAt(i));}
    str(0,'RIFF');view.setUint32(4,data.byteLength-8,true);str(8,'WAVEfmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,sampleRate,true);view.setUint32(28,sampleRate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);str(36,'data');view.setUint32(40,audio.length*2,true);
    for(var i=0;i<audio.length;i++)view.setInt16(44+i*2,Math.max(-1,Math.min(1,audio[i]))*32767,true);
    return new Blob([data],{type:'audio/wav'});
  }
  function speechKey(text){return 'spoken-v4\n'+voice+'\n'+CoSightNarrationText(text);}
  function currentStatus(text){return requests.get(speechKey(text))?.phase||'';}
  function report(job,message){
    job.phase=message;
    if(job.progress)job.progress(message);
    else window.paintVoiceNote?.();
  }
  var queue=[],requests=new Map();
  // Cancelling playback does not discard the loaded model or background audio.
  function cancelSpeech(){if(pending)pending.progress=null;}
  function finish(error,blob){
    const job=pending;if(!job)return;
    clearTimeout(job.timer);pending=null;requests.delete(job.key);
    if(error)job.reject(error);
    else{const url=URL.createObjectURL(blob);urls.set(job.key,url);job.resolve(url);}
    window.paintVoiceNote?.();
    pump();
  }
  async function pump(){
    if(pending||!queue.length)return;
    const job=queue.shift();pending=job;
    try{
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(job.key)))).map(x=>x.toString(16).padStart(2,'0')).join('');
      job.cacheURL=new URL('narration-cache/'+hash,location.href).href;
      try{job.cache=await caches.open('cosight-narration-v4');const cached=await job.cache.match(job.cacheURL);if(cached){finish(null,await cached.blob());return;}}catch{}
      if(!worker){
        worker=new Worker('speech-worker.js',{type:'module'});
        worker.onmessage=async function({data}){
          if(!pending||pending.id!==data.id)return;
          if(data.type==='progress'){report(pending,'Loading voice model · '+Math.round(data.fraction*100)+'%');return;}
          if(data.type==='loading'){report(pending,'Loading voice model…');return;}
          if(data.type==='synthesizing'){report(pending,'Generating narration for this step…');return;}
          if(data.type==='error'){finish(new Error(data.message));return;}
          const job=pending,blob=wav(data.audio,data.sampleRate);
          try{await job.cache?.put(job.cacheURL,new Response(blob,{headers:{'content-type':'audio/wav'}}));}catch{}
          finish(null,blob);
        };
        worker.onerror=function(event){worker?.terminate();worker=null;finish(new Error(event.message||'Voice preparation failed'));};
      }
      job.timer=setTimeout(()=>{worker?.terminate();worker=null;finish(new Error('Voice preparation timed out.'));},180000);
      report(job,'Preparing narration…');worker.postMessage({id:job.id,text:job.text,voice:job.voice});
    }catch(error){finish(error);}
  }
  function prepare(text,onProgress,background=false){
    text=CoSightNarrationText(text);
    const key='spoken-v4\n'+voice+'\n'+text;
    if(urls.has(key))return Promise.resolve(urls.get(key));
    const existing=requests.get(key);
    if(existing){if(onProgress){existing.progress=onProgress;onProgress(existing.phase||'Waiting for narration…');}if(!background&&queue.includes(existing)){queue.splice(queue.indexOf(existing),1);queue.unshift(existing);}return existing.promise;}
    const job={id:++sequence,key,text,voice,progress:onProgress};
    job.promise=new Promise((resolve,reject)=>{job.resolve=resolve;job.reject=reject;});requests.set(key,job);
    if(background)queue.push(job);else queue.unshift(job);pump();return job.promise;
  }
  var prefetchScope='';
  function prefetchTour(){
    if(engine!=='moonshine'||document.body.classList.contains('home-mode')||!window.doc)return;
    const scope=voice+'\n'+doc.project+'\n'+doc.tourId;
    if(scope!==prefetchScope){prefetchScope=scope;for(const job of queue){requests.delete(job.key);job.reject(new DOMException('Tour changed','AbortError'));}queue=[];}
    const entries=[...(doc.stops||[]),...(doc.asides||[])];
    const current=typeof curEntry==='function'?curEntry():null;
    const at=Math.max(0,entries.findIndex(e=>e.id===current?.id));
    [...entries.slice(at),...entries.slice(0,at)].forEach(e=>{if(e.say)prepare(e.say,null,true).catch(()=>{});});
  }
  async function loadMic(){
    if(mic)return mic;
    if(!micLoad)micLoad=(async function(){
      var sdk=await import('./moonshine/index.js');
      var instance=new sdk.MicTranscriber().language('en').modelArch(sdk.ModelArch[model])
        .audioConstraints({echoCancellation:true,noiseSuppression:true,autoGainControl:true})
        .onProgress(function(fraction){if(loadingMic)status('Downloading Moonshine speech model · '+Math.round(fraction*100)+'%');})
        .onText(function(text){if(recording||stopping){partial=text;renderTranscript();}})
        .onLine(function(line){if(recording||stopping){finalLines.set(line.id,line.text);partial='';renderTranscript();}})
        .onError(function(error){status('Microphone: '+error.message);});
      try{await instance.load();mic=instance;return instance;}catch(error){instance.close();throw error;}
    })().finally(function(){micLoad=null;});
    return micLoad;
  }
  async function stopMic(){
    cancelStart=true;micAttempt++;
    if(loadingMic){loadingMic=false;setMicState();status('Microphone preparation cancelled. You can type your question.');return;}
    if(!recording||stopping)return;
    stopping=true;recording=false;setMicState();
    try{await mic.stop();partial='';renderTranscript();status('Voice input ready — edit your question, then Send.');}
    catch(error){status('Could not finish dictation: '+error.message);}
    finally{stopping=false;setMicState();$('askin').focus();}
  }
  async function toggleMic(){
    if(recording||loadingMic){await stopMic();return;}
    if(window.reviewingArchive){status('Return to the live tour before asking a question.');return;}
    if(!navigator.mediaDevices?.getUserMedia){status('Microphone access needs localhost or HTTPS. You can still type your question.');return;}
    pauseNow();var attempt=++micAttempt;cancelStart=false;loadingMic=true;sessionProject=window.doc?.project;sessionTour=window.doc?.tourId;base=$('askin').value.trim();finalLines.clear();partial='';setMicState();status('Preparing Moonshine dictation…');
    try{
      var device=await loadMic();
      if(cancelStart||attempt!==micAttempt)return;
      recording=true;await device.start();
      if(cancelStart||attempt!==micAttempt){await device.stop();recording=false;return;}
      status('Listening locally… click the mic again to finish.');
    }catch(error){recording=false;try{await mic?.stop();}catch{}status(error.name==='NotAllowedError'?'Microphone permission was denied. Allow microphone access or type your question.':'Voice input unavailable: '+error.message);}
    finally{if(attempt===micAttempt){loadingMic=false;setMicState();}}
  }
  window.CoSightSpeech={engine:()=>engine,prepare,prefetchTour,currentStatus,cancel:cancelSpeech,recording:()=>recording||loadingMic,stopMic};
  $('bMic').onclick=toggleMic;
  $('voiceEngine').value=engine;$('moonshineVoice').value=voice;$('micModel').value=model;
  $('voiceEngine').onchange=function(){engine=this.value;store('cosight:voiceEngine',engine);stopSpeech();paintVoiceNote();};
  $('moonshineVoice').onchange=function(){voice=this.value;store('cosight:moonshineVoice',voice);stopSpeech();prefetchTour();};
  $('micModel').onchange=async function(){await stopMic();if(loadingMic){status('Wait for the model preparation to finish before changing its size.');this.value=model;return;}mic?.close();mic=null;model=this.value;store('cosight:micModel',model);};
  $('bVoicePreview').onclick=function(){paused=false;var entry=curEntry();if(entry)speak(entry);else status('Start a tour to preview the selected narration voice.');};
  document.addEventListener('keydown',function(event){if(recording||loadingMic){if(event.key==='Escape'){event.preventDefault();stopMic();}if(event.key==='Enter'&&event.target===$('askin')){event.preventDefault();event.stopImmediatePropagation();stopMic();}}},true);
  window.addEventListener('cosight:document',function(event){if((recording||loadingMic)&&(sessionProject!==event.detail.project||sessionTour!==event.detail.tourId))stopMic();});
  window.addEventListener('pagehide',function(){mic?.close();cancelSpeech();worker?.terminate();for(var url of urls.values())URL.revokeObjectURL(url);});
  setMicState();window.dispatchEvent(new Event('cosight:speech-ready'));prefetchTour();
})();
