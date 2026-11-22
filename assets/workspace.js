/* Reuse the real controls and handlers: moving a control never replaces its behavior. */
(function(){
  const el=id=>document.getElementById(id);
  const paths={back:'M15 18l-6-6 6-6',home:'M3 12l9-9 9 9M5 10v10h14V10M9 20v-7h6v7',settings:'M4 7h16M4 17h16M8 4v6M16 14v6',split:'M12 3v18M3 3h18v18H3z',stack:'M3 12h18M3 3h18v18H3z',map:'M4 4h6v6H4zM14 14h6v6h-6zM7 10v7h7',code:'M8 6l-6 6 6 6M16 6l6 6-6 6',list:'M8 6h13M8 12h13M8 18h13M3 6h1M3 12h1M3 18h1',play:'M8 4l12 8-12 8z',pause:'M8 4v16M16 4v16',next:'M5 4l12 8-12 8zM20 4v16',prev:'M19 4L7 12l12 8zM4 4v16',send:'M12 20V4M5 11l7-7 7 7',hand:'M7 12V6a2 2 0 0 1 4 0v5M11 5a2 2 0 0 1 4 0v6M15 7a2 2 0 0 1 4 0v8c0 8-10 8-12 3l-4-5q0-4 4-1',fit:'M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6',target:'M12 3v18M3 12h18M5 5h14v14H5z',live:'M12 9v6M8 6a8 8 0 0 0 0 12M16 6a8 8 0 0 1 0 12',export:'M12 3v12M7 8l5-5 5 5M4 14v7h16v-7'};
  const svg=n=>'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+paths[n]+'"/></svg>';
  function icon(node,name,label){node.innerHTML=svg(name);node.title=label;node.setAttribute('aria-label',label);node.classList.add('quiet-icon');}
  const watched=new WeakSet();
  const baseIcon=icon;
  icon=function(node,name,label){
    baseIcon(node,name,label);
    if(!watched.has(node)){
      watched.add(node);
      new MutationObserver(()=>{
        if(node.textContent.trim() && !(node.id==='bSend'&&document.body.classList.contains('home-mode'))){
          const dynamic=node.title||label;baseIcon(node,name,dynamic);
        }
      }).observe(node,{childList:true});
    }
  };
  const panel=document.createElement('aside');panel.id='workspaceActions';panel.hidden=true;panel.setAttribute('aria-label','Workspace actions');panel.innerHTML='<div class="workspace-heading">Workspace<button id="workspaceClose" aria-label="Close workspace panel">×</button></div><div id="workspaceGeneral"></div><h3>Audio</h3><div id="workspaceAudio"></div>';
  document.body.append(panel);
  const launcher=document.createElement('button');launcher.id='workspaceToggle';icon(launcher,'settings','Workspace actions');el('hbtns').append(launcher);
  const move=(id,to)=>el(to).append(el(id));
  ['bLibrary','bAnalysis','bRestart','bHelp','bSettings','modesw'].forEach(id=>move(id,'workspaceGeneral'));
  ['rate','bAudio'].forEach(id=>move(id,'workspaceAudio'));
  launcher.onclick=()=>{panel.hidden=!panel.hidden;launcher.setAttribute('aria-expanded',String(!panel.hidden));};
  el('workspaceClose').onclick=()=>panel.hidden=true;
  panel.addEventListener('click',e=>{if(e.target.closest('#bLibrary,#bSettings,#bHelp'))panel.hidden=true;});
  document.addEventListener('keydown',e=>{if(e.key==='Escape')panel.hidden=true;});
  move('layout','hbtns');el('hbtns').insertBefore(el('layout'),launcher);
  const stack=document.createElement('button');stack.dataset.l='stack';stack.title='Diagram and code stacked vertically';el('layout').insertBefore(stack,el('layout').children[1]);stack.onclick=()=>setLayout('stack',true);
  el('layout').querySelectorAll('button').forEach(b=>icon(b,{split:'split',stack:'stack',map:'map',code:'code'}[b.dataset.l],b.title));
  [['bHome','home','Project overview and saved tours'],['bPrev','prev','Previous step (Left)'],['bNext','next','Next step (Right)'],['bLive','live','Latest live step (L)'],['bSend','send','Send question'],['bHold','hand','Ask the agent to pause here (H)'],['zFit','fit','Fit diagram (0)'],['bRange','target','Return to highlighted source lines'],['bFlip','map','Toggle project map / current step (O)']].forEach(([id,n,label])=>icon(el(id),n,label));
  el('bRoute').classList.add('quiet-icon');move('bMute','controls');
  // Playback labels are updated by the tour state; observe and retain that state in the icon.
  const play=el('bPlay');function syncPlay(){
    const label=play.textContent.trim();if(label)baseIcon(play,/Pause/.test(label)?'pause':'play',label+' narration (Space)');
  }
  new MutationObserver(syncPlay).observe(play,{childList:true});syncPlay();
  const controls=el('controls');
  for(const [id,items] of [['transportContext',['atime','voice']],['transportPlayback',['bPrev','bPlay','bNext']],['transportActions',['bLive','bMute']]]){
    const group=document.createElement('div');group.id=id;
    items.forEach(item=>group.append(el(item)));controls.append(group);
  }
  const sidebarIcons=document.createElement('div');sidebarIcons.id='workspaceShortcuts';
  ['bRestart','bHelp','bSettings'].forEach(id=>{const button=el(id);button.setAttribute('aria-label',button.title);sidebarIcons.append(button);});
  el('workspaceGeneral').insertBefore(sidebarIcons,el('modesw'));
  el('bLibrary').textContent='Agents & settings';
  el('bAudio').title='Replay this step (R)';el('bAudio').setAttribute('aria-label','Replay this step (R)');
  ['bMute','bReturnLive','bMic'].forEach(id=>{const b=el(id);b.setAttribute('aria-label',b.title||b.textContent);});
  const tip=document.createElement('div');tip.id='workspaceTooltip';tip.role='tooltip';tip.hidden=true;document.body.append(tip);
  function show(e){const b=e.target.closest('button[title]');if(!b||!b.title)return;tip.textContent=b.title;tip.hidden=false;const box=b.getBoundingClientRect();tip.style.left=Math.max(8,Math.min(innerWidth-tip.offsetWidth-8,box.left))+'px';tip.style.top=(box.bottom+tip.offsetHeight+12<innerHeight?box.bottom+7:box.top-tip.offsetHeight-7)+'px';}
  document.addEventListener('pointerover',show);document.addEventListener('focusin',show);document.addEventListener('pointerout',()=>tip.hidden=true);document.addEventListener('focusout',()=>tip.hidden=true);document.addEventListener('click',()=>tip.hidden=true);
})();
