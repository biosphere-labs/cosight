(function(){
  const home=$('home');
  home.innerHTML=`<div class="home-shell">
    <nav class="home-nav"><div class="home-brand"><img src="icons/atlas.svg" alt="" width="42" height="42"><span>CoSight</span></div><div><button id="homeExperimental" hidden>Analysis & plugins</button><button id="homeSwitch">Projects</button><button id="homeSettings">Agents & settings</button></div></nav>
    <section id="homePicker" aria-label="Select a project"><p class="home-eyebrow">START HERE</p><h1>Choose a project</h1><p>Open a project folder to explore it and ask questions. Git is optional.</p><button id="homeChoose">Choose folder…</button><form id="homePathForm" hidden><label>Project folder<input id="homePath" placeholder="/absolute/path/to/project" required></label><button type="submit">Open project</button></form><h2>Recent projects</h2><div id="homeRecent"></div><p id="homePickerMessage" role="status"></p></section>
    <main id="homeOverview" class="home-content" hidden><p id="homeProjectPath" class="home-eyebrow"></p><h1 id="homeTitle">Your codebase, with a guide.</h1><p id="homeDescription" class="home-description"></p>
    <div id="homeIntroduction"></div>
    <section class="home-question-card" aria-label="Ask about this project"><h2>What would you like to understand?</h2><p>Ask about the purpose, a feature, or how the pieces connect.</p><form id="homeQuestionForm"><div id="homeQuestionControls"></div></form><div id="homeMicStatus"></div><div id="homeSuggestions"><select id="homeExplore" aria-label="Explore a topic"><option value="">Explore a topic…</option><option value="What does this project do?">Purpose</option><option value="Walk me through the main modules">Modules & architecture</option><option value="Trace a request through the code">Execution flow</option></select></div><p id="homeAgentHint"></p></section>
    <div id="homeProgress" hidden><img src="icons/atlas-loading.svg" width="40" height="40" alt=""><span>Getting things ready. Exploring your project…</span><button id="homeStop">Stop</button></div><p id="homeMessage" role="status" aria-live="polite"></p>
    <div class="home-context"><details id="homeReadme" hidden><summary id="homeReadmeTitle">Project README</summary><pre id="homeReadmeText"></pre></details><div id="homeFiles"></div></div>
    <section class="home-tours"><div class="home-section-title"><h2>Saved tours</h2><div><button id="homeResume" hidden>Resume current tour</button><label><input type="checkbox" id="homeAllTours"> Show all projects</label></div></div><div id="homeTours">Choose a project to get started.</div></section></main>
  </div>`;
  let data=null,selected=false,pending=false,pendingProject='',previousTour='',version=0,poll;
  const anchors=new Map();
  for(const id of ['askfield','bSend','micStatus','previousQuestions']){const node=$(id),anchor=document.createComment(id);node.before(anchor);anchors.set(id,{node,anchor});}
  $('bSend').type='button';
  function visible(){return document.body.classList.contains('home-mode');}
  function message(text){$('homeMessage').textContent=text;$('homePickerMessage').textContent=text;}
  async function api(url,input){const response=await fetch(url,input===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});const result=await response.json();if(!response.ok)throw Error(result.error||'Could not load the project');return result;}
  function busy(){return pending;}
  function controls(){
    $('homeProgress').hidden=!pending;
    $('bSend').disabled=pending||!!window.CoSightSpeech?.recording();
    $('bMic').disabled=pending;
  }
  function moveQuestion(toHome){
    if(toHome){$('homeSuggestions').append($('previousQuestions'));$('homeQuestionControls').append($('askfield'),$('bSend'));$('homeMicStatus').append($('micStatus'));$('bSend').textContent='Ask CoSight';$('askin').placeholder='How does this project work?';$('askin').setAttribute('aria-label','Ask a question about this project');}
    else{for(const {node,anchor} of anchors.values())anchor.after(node);$('bSend').textContent='Send';$('askin').placeholder='Ask a question about this step…';$('askin').setAttribute('aria-label','Ask a question about this tour step');}
  }
  function hide(){setTimeout(()=>window.CoSightSpeech?.prefetchTour(),0);pauseNow();stopSpeech();document.body.classList.remove('home-mode');home.hidden=true;moveQuestion(false);window.CoSightSplash?.refresh();}
  function show(){pauseNow();stopSpeech();
    pauseNow();autoplay=false;home.hidden=false;document.body.classList.add('home-mode');reviewingArchive=false;if(liveDoc&&doc!==liveDoc)apply(liveDoc,true);moveQuestion(true);controls();
    document.body.classList.toggle('home-picking',!selected);$('homePicker').hidden=selected;$('homeOverview').hidden=!selected;
    window.CoSightSplash?.refresh();refresh().catch(e=>message(e.message));
  }
  async function refresh(){
    const request=++version,next=await api('home');if(request!==version)return;
    const old=data?.project;
    if(old!==next.project){if(old!==undefined)store('cosight:homeDraft:'+old,$('askin').value);$('askin').value=load('cosight:homeDraft:'+next.project,'');}
    data=next;
    $('homeTitle').textContent=next.project?next.overview.name:'Your codebase, with a guide.';
    $('homeProjectPath').textContent=next.project||'START WITH A PROJECT FOLDER';
    $('homeDescription').textContent=next.project?(next.overview.description||'Explore the project, ask a question, or revisit a saved tour.'):'Choose a folder to see what the project is about and decide where to explore. Git is optional.';
    $('homeIntroduction').replaceChildren();
    if(next.overview.paragraphs?.length){const source=document.createElement('p');source.className='home-eyebrow';source.textContent=next.overview.source||('From '+(next.overview.readme?.file||'project files'));$('homeIntroduction').append(source);}
    for(const text of next.overview.paragraphs||[]){const p=document.createElement('p');p.textContent=text;$('homeIntroduction').append(p);}
    if(next.overview.error)message(next.overview.error);
    const readme=next.overview.readme;$('homeReadme').hidden=!readme;$('homeReadmeTitle').textContent=readme?'From '+readme.file:'Project README';$('homeReadmeText').textContent=readme?.excerpt||'';
    $('homeFiles').replaceChildren();
    for(const entry of next.overview.entries||[]){const chip=document.createElement('span');chip.textContent=entry.name+(entry.directory?'/':'');$('homeFiles').append(chip);}
    $('homeRecent').replaceChildren();
    for(const item of next.projects){const button=document.createElement('button');button.className='home-project-choice';const title=document.createElement('strong'),detail=document.createElement('span');title.textContent=item.name;detail.textContent=item.path;button.append(title,detail);button.onclick=()=>openProject(item.path);$('homeRecent').append(button);}
    if(!next.projects.length)$('homeRecent').textContent='Your projects will appear here after you open them.';
    $('homeExperimental').hidden=!next.features.analysisPlugins;
    $('homeAgentHint').replaceChildren();
    if(next.project&&!next.agent.configured){const button=document.createElement('button');button.textContent='Set up an agent to answer questions';button.onclick=()=>{sessionStorage.setItem('cosight:setupShown','1');$('bLibrary').click();};$('homeAgentHint').append(button);}
    else $('homeAgentHint').textContent=next.project?'Questions use your configured '+next.agent.provider+' agent.':'Choose a project before asking a question.';
    $('homeResume').hidden=!(window.liveDoc?.project===next.project&&window.liveDoc?.stops?.length);
    await drawTours();controls();
  }
  async function drawTours(){
    const requestedProject=data?.project;
    const tours=$('homeAllTours').checked?(await api('library?project=')).tours:data?.tours||[];
    if(data?.project!==requestedProject)return;
    const list=$('homeTours');list.replaceChildren();
    for(const tour of tours){
      const card=document.createElement('button');card.type='button';card.className='home-tour';
      const title=document.createElement('strong');title.textContent=tour.question||'Untitled tour';
      const detail=document.createElement('span'),stamp=Number(tour.tourId.replace(/^t-/,''));
      detail.textContent=tour.stops.length+' stops'+(stamp&&Number.isFinite(stamp)?' · '+new Date(stamp).toLocaleString():'')+($('homeAllTours').checked?' · '+tour.project:'');
      card.append(title,detail);card.onclick=async()=>{try{await window.CoSightLibrary.openTour(tour);}catch(e){show();message('Could not open this tour: '+e.message);}};list.append(card);
    }
    if(!tours.length)list.textContent='No saved tours yet. Ask a question above to start exploring.';
  }
  async function openProject(project){
    if(pending){message('Stop the current question before changing projects.');return;}
    try{await window.CoSightSpeech?.stopMic();await api('project',{project});selected=true;$('homeAllTours').checked=false;document.body.classList.remove('home-picking');$('homePicker').hidden=true;$('homeOverview').hidden=false;reviewingArchive=false;paused=true;autoplay=false;apply(await api('tour'));await refresh();$('homePathForm').hidden=true;message('');return true;}catch(e){message(e.message);return false;}
  }
  async function choose(){
    if(window.coSightDesktop){const project=await window.coSightDesktop.chooseProject();if(project)await openProject(project);}
    else{$('homePathForm').hidden=false;$('homePath').focus();}
  }
  function showPicker(){if(pending){message('Stop the current question before changing projects.');return;}selected=false;window.CoSightSpeech?.stopMic();show();}
  async function askProject(text){
    if(pending||window.CoSightSpeech?.recording())return;
    text=(text||'').trim();if(!text){$('askin').focus();return;}
    if(!selected||!data?.project){message('Choose a project folder first. Your question is kept here.');return;}
    // Re-read configuration, so closing setup always uses what was actually saved.
    const current=await api('library?project='+encodeURIComponent(data.project)).catch(e=>{message(e.message);return null;});
    if(!current||pending)return;
    if(current.settings.agent.provider==='external'){message('Choose and save a local agent for this project. Your question is kept here.');$('bLibrary').click();return;}
    pending=true;pendingProject=data.project;previousTour=window.liveDoc?.tourId||'';reviewingArchive=false;controls();message('');
    try{
      await api('request',{kind:'tour',project:pendingProject,text});
      // The event stream opens the result as soon as a real stop is available.
      inspect(await api('tour'));clearTimeout(poll);poll=setTimeout(checkPending,1000);
    }catch(e){pending=false;controls();message(e.message);}
  }
  function inspect(doc){
    if(!pending||doc.project!==pendingProject||doc.tourId===previousTour)return;
    if(doc.stops?.length){pending=false;clearTimeout(poll);$('askin').value='';store('cosight:homeDraft:'+pendingProject,'');controls();hide();}
    else if(doc.phase==='done'){
      pending=false;clearTimeout(poll);controls();message(doc.agentRun?.error||doc.status||'No answer was delivered. Your question is kept here.');
    }
  }
  async function checkPending(){
    if(!pending)return;
    try{const doc=await api('tour');inspect(doc);if(pending){$('homeProgress').querySelector('span').textContent=doc.status||'Getting things ready. Exploring your project…';poll=setTimeout(checkPending,1000);}}
    catch(e){pending=false;controls();message('Could not reconnect. Your question is kept here.');}
  }
  window.CoSightHome={show,hide,refresh,ask:askProject,visible,busy,showPicker,project:()=>data?.project,openProject};
  $('bHome').onclick=show;
  $('homeChoose').onclick=choose;$('homeSwitch').onclick=showPicker;
  $('homeSettings').onclick=()=>{sessionStorage.setItem('cosight:setupShown','1');$('bLibrary').click();};
  $('homeExperimental').onclick=()=>$('bAnalysis').click();
  $('homePathForm').onsubmit=e=>{e.preventDefault();openProject($('homePath').value.trim());};
  $('homeQuestionForm').onsubmit=e=>{e.preventDefault();askProject($('askin').value);};
  $('homeAllTours').onchange=()=>drawTours().catch(e=>message(e.message));
  $('homeResume').onclick=()=>{reviewingArchive=false;paused=true;autoplay=false;hide();if(liveDoc)apply(liveDoc,true);};
  $('homeStop').onclick=async()=>{try{await api('agent/stop',{});pending=false;clearTimeout(poll);controls();message('Stopped. Your question is kept here.');}catch(e){message(e.message);}};
  $('homeExplore').onchange=function(){if(!this.value)return;$('askin').value=this.value;$('askin').dispatchEvent(new Event('input'));this.value='';$('askin').focus();};
  $('askin').addEventListener('input',()=>{if(visible()&&data)store('cosight:homeDraft:'+data.project,$('askin').value);});
  home.addEventListener('keydown',e=>e.stopPropagation());
  window.addEventListener('cosight:document',event=>{inspect(event.detail);if(visible()&&data&&event.detail.project!==data.project)refresh().catch(e=>message(e.message));});
  window.addEventListener('cosight:configured',()=>refresh().catch(e=>message(e.message)));
  show();
})();
