/* Uses the same canvas renderer for archived tours without replacing the agent's live file. */
(function(){
  var data=null, project='',preferenceQueue=Promise.resolve();
  var message=function(text){ $('libMessage').textContent=text; };
  var guidance=null,availableChoices=[],lastAgentStatus={};
  function mountGuidance(){
    if(guidance)return guidance;
    var input=$('libInstructions'),label=input.closest('label');
    if(label){Array.from(label.childNodes).filter(function(n){return n.nodeType===3;}).forEach(function(n){n.remove();});label.insertBefore(document.createTextNode('Project additions (extend shared guidance) '),input);}
    var defaults=document.createElement('button');defaults.id='libDefaultInstructions';defaults.type='button';defaults.textContent='Built-in guidance · view or edit';
    var effective=document.createElement('details'),summary=document.createElement('summary'),preview=document.createElement('pre');effective.id='libEffectiveInstructions';summary.textContent='Preview effective instructions';preview.id='libEffectiveInstructionsText';preview.style.whiteSpace='pre-wrap';effective.append(summary,preview);
    var anchor=label||input;anchor.insertAdjacentElement('beforebegin',defaults);anchor.insertAdjacentElement('afterend',effective);
    var dialog=document.createElement('dialog');dialog.id='libGuidanceDialog';dialog.setAttribute('aria-label','Shared guidance');
    dialog.innerHTML='<header><h3>Shared guidance</h3><button type="button" id="libGuidanceClose" aria-label="Close guidance">×</button></header><p>Applies to every project. Project additions extend this guidance.</p><textarea id="libDefaultInstructionsText" aria-label="Shared guidance text" maxlength="32000"></textarea><p id="libGuidanceInfo"></p><p id="libGuidanceMessage" role="status"></p><footer><button type="button" id="libGuidanceRestore">Restore default</button><button type="button" id="libGuidanceCancel">Cancel</button><button type="button" id="libGuidanceSave" class="go">Save guidance</button></footer>';
    document.body.append(dialog);guidance={preview:preview,settings:null,dialog:dialog,baseline:$('libDefaultInstructionsText')};
    function close(){dialog.close();defaults.focus();}
    defaults.onclick=function(){guidance.baseline.value=guidance.settings.defaultInstructions;$('libGuidanceMessage').textContent='';dialog.showModal();guidance.baseline.focus();};
    $('libGuidanceCancel').onclick=close;$('libGuidanceClose').onclick=close;
    dialog.addEventListener('cancel',function(e){e.preventDefault();e.stopPropagation();close();});
    dialog.addEventListener('keydown',function(e){if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();close();}});
    $('libGuidanceRestore').onclick=function(){guidance.baseline.value=guidance.settings.factoryInstructions;$('libGuidanceMessage').textContent='Default restored in this draft. Save guidance to apply it.';};
    $('libGuidanceSave').onclick=async function(){var save=$('libGuidanceSave');save.disabled=true;try{var result=await api('guidance',{text:guidance.baseline.value});Object.assign(guidance.settings,{defaultInstructions:result.value.text,factoryInstructions:result.value.factoryText,defaultInstructionsVersion:result.value.version,guidanceHash:result.value.hash,guidanceCustomized:result.value.customized});renderGuidance();close();message('Shared guidance saved for all projects. Project additions were kept.');}catch(e){$('libGuidanceMessage').textContent=e.message;}finally{save.disabled=false;}};
    input.addEventListener('input',renderGuidance);return guidance;
  }
  function renderGuidance(){
    var view=mountGuidance(),settings=view.settings;if(!settings)return;
    $('libDefaultInstructions').textContent='Built-in guidance · '+(settings.guidanceCustomized?'customized':'default')+' · view or edit';
    $('libGuidanceInfo').textContent='Default version '+settings.defaultInstructionsVersion+' · '+(settings.guidanceCustomized?'Customized':'Using shipped default');
    var additions=$('libInstructions').value;
    view.preview.textContent='Built-in CoSight guidance (version '+settings.defaultInstructionsVersion+')\n'+(settings.defaultInstructions||'')+(additions.trim()?'\n\nProject additions (extend built-in guidance)\nThese additions specialize the task; retain the built-in guidance if they conflict.\n'+additions:'');
  }
  async function refreshAgents(agent){
    var detected=await api('agent/available');availableChoices=detected.agents||[];
    $('libProvider').replaceChildren();availableChoices.filter(function(a){return a.available||a.id===agent.provider;}).forEach(function(a){$('libProvider').add(new Option(a.title+(a.available?'':' · unavailable'),a.id));});
    $('libProvider').add(new Option('Custom agent…','custom'));
    if(agent.provider==='external')$('libProvider').add(new Option('External agent','external'));
    $('libProvider').value=agent.provider;
  }

  async function openTour(t,entry){
    var shown=structuredClone(t);shown.tts={state:'off'};
    // Archive navigation never waits for a serial audio probe for every stop.
    await Promise.all([].concat(shown.stops||[],shown.asides||[]).map(async function(s){
      var hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1',new TextEncoder().encode(CoSightNarrationText(s.say||''))))).map(function(v){return v.toString(16).padStart(2,'0');}).join('');
      s.audio='audio/'+hash+'.mp3';
    }));
    var live=liveDoc;reviewingArchive=false;paused=true;autoplay=false;
    window.CoSightHome?.hide();apply(shown,true);liveDoc=live;reviewingArchive=true;
    if(entry)show(entry,false);
    $('bReturnLive').hidden=false;$('library').hidden=true;window.CoSightSplash?.refresh();
  }
  window.CoSightLibrary={openTour};
  async function api(url, value){
    var job=window.CoSightSplash?window.CoSightSplash.begin(value===undefined?'Loading your workspace…':'Saving your choices…'):null;
    try {
    var r=await fetch(url, value===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
    var d=await r.json(); if(!r.ok) throw Error(d.error||'Request failed'); return d;
    }finally{if(job!==null)window.CoSightSplash.end(job);}
  }
  async function refresh(){
    // Setup can open before the first event-stream message. Read the active
    // project from the server instead of capturing an empty liveDoc at startup.
    project=(await api('tour')).project||'';
    data=await api('library?project='+encodeURIComponent($('libAll').checked?'':project));
    // The project saved here is always the connected agent's project, even in an archived tour.
    $('libProjectPath').value=project;
    $('libProject').textContent=project||'Start a tour from an agent in your project to save its instructions.';
    var current=await api('library?project='+encodeURIComponent(project));
    $('libInstructions').value=current.settings.instructions||'';
    mountGuidance().settings=current.settings;renderGuidance();
    var agent=current.settings.agent,serena=current.settings.serena;
    await refreshAgents(agent); $('libAgentCommand').value=agent.command; $('libModel').value=agent.model;
    $('libAgentArgs').value=JSON.stringify(agent.args); $('libSerena').checked=serena.enabled;
    $('libSerenaCommand').value=serena.command; $('libSerenaArgs').value=JSON.stringify(serena.args);
    var status=await api('agent/status');lastAgentStatus=status;renderLogin();$('libStopAgent').hidden=!status.running;
    $('libAgentStatus').textContent=status.running?'Running '+status.provider+' · '+(status.runDir||''):status.error||'No agent running. Sign-in has not been checked here.';
    $('libName').value=current.settings.preset||'';
    if(project)$('libMcpConfig').textContent=JSON.stringify(await api('mcp-config'),null,2);
    $('libPresets').replaceChildren(new Option('Choose a preset',''));
    data.presets.forEach(function(p){ $('libPresets').add(new Option(p.name+(p.source==='example'?' · example':''),p.name)); });
    $('libTours').replaceChildren();
    data.tours.forEach(function(t){
      var b=document.createElement('button');
      var ms=Number(t.tourId.replace(/^t-/,''));
      b.textContent=(isFinite(ms)?new Date(ms).toLocaleString()+' · ':'')+(t.question||'Untitled tour')+' · '+t.stops.length+' stops'+($('libAll').checked?' · '+t.project:'');
      b.onclick=async function(){ try{
        await openTour(t);
      }catch(e){message(e.message);} };
      $('libTours').appendChild(b);
    });
    if(!data.tours.length) $('libTours').textContent='No tours saved for this project yet.';
  }
  $('bLibrary').onclick=async function(){
    $('library').hidden=false; message('Loading…');
    var controls=['libProvider','libAgentCommand','libModel','libAgentArgs','libSerena','libSerenaCommand','libSerenaArgs','libInstructions','libName','libPresets','libSave','libPresetSave','libRun','libAll'];
    controls.forEach(function(id){$(id).disabled=true;});
    try{ await refresh(); message(''); }catch(e){message(e.message);}
    finally{controls.forEach(function(id){$(id).disabled=false;});}
  };
  $('libClose').onclick=async function(){try{await preferenceQueue;if(project)await save();else await savePreferences();$('library').hidden=true;window.CoSightHome?.show();window.CoSightSplash?.refresh();}catch(e){message(e.message);}};
  $('libAll').onchange=async function(){
    var ids=['libInstructions','libName','libProvider','libAgentCommand','libModel','libAgentArgs','libSerena','libSerenaCommand','libSerenaArgs'];
    var edits=ids.map(function(id){return {id:id,value:$(id).value,checked:$(id).checked};});
    try{await refresh(); edits.forEach(function(edit){$(edit.id).value=edit.value;$(edit.id).checked=edit.checked;});renderGuidance();}catch(e){message(e.message);}
  };
  $('libPresets').onchange=function(){ if(!data)return; var p=data.presets.find(function(p){return p.name===$('libPresets').value;}); if(p){$('libInstructions').value=p.instructions; $('libName').value=p.name;renderGuidance();} };
  function renderLogin(){
    var provider=$('libProvider').value,choice=availableChoices.find(function(a){return a.id===provider;}),supported=['codex','claude','antigravity'].includes(provider),available=!!choice?.available;
    $('libLogin').hidden=!supported;
    $('libLogin').disabled=supported&&available&&!window.coSightDesktop?.providerLogin;
    $('libLogin').textContent=available?'Connect '+choice.title:'Review setup';
    $('libLoginHelp').textContent=supported?(available?'Agent found. Sign-in has not been checked. Uses your existing subscription login.':'The selected agent is unavailable on this computer. Choose another agent or review its executable.'):provider==='custom'?'Use an installed executable with your existing account configuration.':'Your external agent connects independently. Copy its connection configuration under Advanced.';
    var permissionNeeded=provider==='antigravity'&&lastAgentStatus.provider==='antigravity'&&/^Antigravity denied required tools:/i.test(lastAgentStatus.error||'');$('libSetupAgy').hidden=!permissionNeeded;$('libSetupHelp').hidden=!permissionNeeded;
  }
  $('libLogin').onclick=async function(){try{var choice=availableChoices.find(function(a){return a.id===$('libProvider').value;});if(!choice?.available){document.querySelector('#library .agent-advanced').open=true;$('libAgentCommand').focus();return;}await window.coSightDesktop.providerLogin($('libProvider').value);message('Complete sign-in in the opened agent, then return here. Opening sign-in does not confirm authentication.');}catch(e){message(e.message);}};
  $('libExternal').onclick=function(){if(!Array.from($('libProvider').options).some(function(o){return o.value==='external';}))$('libProvider').add(new Option('External agent','external'));$('libProvider').value='external';renderLogin();autoSavePreferences();};
  $('libDiagnostics').onclick=async function(){try{var status=await api('agent/status');await navigator.clipboard.writeText(JSON.stringify({provider:$('libProvider').value,availableAgents:availableChoices.map(function(a){return {id:a.id,available:a.available};}),running:status.running,error:status.error||''},null,2));message('Diagnostic information copied.');}catch(e){message(e.message);}};
  function preferencesFromForm(){
    return {agent:{provider:$('libProvider').value,command:$('libAgentCommand').value.trim(),model:$('libModel').value.trim(),args:JSON.parse($('libAgentArgs').value||'[]')},serena:{enabled:$('libSerena').checked,command:$('libSerenaCommand').value.trim(),args:JSON.parse($('libSerenaArgs').value||'[]')}};
  }
  function savePreferences(){
    let value;try{value=preferencesFromForm();}catch(e){message('Enter valid JSON arguments before saving.');return Promise.reject(e);}
    const next=preferenceQueue.catch(()=>{}).then(()=>api('agent/preferences',value)).then(()=>{message('Agent settings saved for all projects.');window.dispatchEvent(new Event('cosight:configured'));});
    preferenceQueue=next.catch(e=>message(e.message));return next;
  }
  function autoSavePreferences(){
    if($('libProvider').value==='custom'&&!$('libAgentCommand').value.trim()){message('Enter the custom executable to finish saving this agent.');return;}
    savePreferences().catch(()=>{});
  }
  $('libProvider').onchange=function(){ $('libAgentCommand').value='';$('libAgentArgs').value='[]';$('libModel').value='';renderLogin();autoSavePreferences(); };
  for(const id of ['libAgentCommand','libModel','libAgentArgs','libSerena','libSerenaCommand','libSerenaArgs'])$(id).addEventListener('change',autoSavePreferences);
  async function save(){
    await preferenceQueue;
    if(project!==((await api('tour')).project||'')) throw Error('The active project changed. Close and reopen this panel.');
    var {agent,serena}=preferencesFromForm();
    await api('settings',{project:project,instructions:$('libInstructions').value,preset:$('libName').value,agent:agent,serena:serena});
    window.dispatchEvent(new Event('cosight:configured'));
    window.CoSightHome?.refresh();
    message('Saved for '+project);
  }
  if(window.coSightDesktop){
    $('libBrowseProject').hidden=false;
    $('libBrowseProject').onclick=async function(){var chosen=await window.coSightDesktop.chooseProject(); if(chosen){$('libProjectPath').value=chosen; $('libOpenProject').click();}};
  }
  $('libOpenProject').onclick=async function(){
    try{var d=await api('project',{project:$('libProjectPath').value.trim()});
      var live=await api('tour'); reviewingArchive=false; paused=true; apply(live); $('bReturnLive').hidden=true;
      await refresh(); if($('libProvider').value==='external') $('libProvider').value='codex'; message('Opened '+d.project+'. Choose an agent and save your instructions.');
    }catch(e){message(e.message);}
  };
  $('libSetupAgy').onclick=async function(){if(!window.confirm('Allow the selected agent to publish CoSight tours and use read-only code navigation? Existing permission rules are retained and current settings are backed up.'))return;try{var result=await api('agent/setup-antigravity',{});message('Agent tour permissions configured.'+(result.backup?' Original settings backed up at '+result.backup:''));}catch(e){message(e.message);}};
  $('libCopyMcp').onclick=async function(){try{await navigator.clipboard.writeText($('libMcpConfig').textContent);message('MCP configuration copied for this project.');}catch(e){message('Select and copy the MCP configuration above.');}};
  $('libStopAgent').onclick=async function(){try{await api('agent/stop',{});message('Stopped the active agent. Delivered stops remain saved.');}catch(e){message(e.message);}};
  $('libSave').onclick=function(){ save().catch(function(e){message(e.message);}); };
  function closePresetEditor(){$('libPresetEditor').hidden=true;$('libPresetSave').focus();}
  $('libPresetSave').onclick=function(){$('libPresetDraftName').value=$('libName').value||'';$('libPresetEditor').hidden=false;$('libPresetDraftName').focus();};
  $('libPresetCancel').onclick=closePresetEditor;
  $('libPresetConfirm').onclick=async function(){var button=$('libPresetConfirm');button.disabled=true;try{var name=$('libPresetDraftName').value.trim();if(!name)throw Error('Enter a preset name.');var result=await api('presets',{name:name,instructions:$('libInstructions').value});$('libName').value=name;data.presets=result.value;$('libPresets').replaceChildren(new Option('Choose a preset',''));data.presets.forEach(function(p){$('libPresets').add(new Option(p.name+(p.source==='example'?' · example':''),p.name));});$('libPresets').value=name;closePresetEditor();message('Reusable preset saved.');}catch(e){message(e.message);}finally{button.disabled=false;}};
  $('libPresetEditor').addEventListener('keydown',function(e){if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();closePresetEditor();}else if(e.key==='Enter'){e.preventDefault();$('libPresetConfirm').click();}});
  $('libRun').onclick=async function(){ try{
    await save();
    if(window.CoSightHome?.visible()){$('library').hidden=true;await window.CoSightHome.ask($('libInstructions').value);return;}
    await api('request',{kind:'tour',project:project,text:$('libInstructions').value});
    message($('libProvider').value==='external'?'Tour requested. The connected agent will pick it up when available.':'Tour requested. '+$('libProvider').selectedOptions[0].textContent+' is starting.');
    $('library').hidden=true;
    reviewingArchive=false; paused=true; autoplay=false; stopSpeech(); $('bReturnLive').hidden=true; var live=await api('tour'); apply(live);
  }catch(e){message(e.message);} };
  $('bReturnLive').onclick=function(){ reviewingArchive=false; paused=true; autoplay=false; stopSpeech(); if(liveDoc) apply(liveDoc,true); this.hidden=true; };
  document.addEventListener('keydown',function(e){ if(e.key==='Escape'&&!$('library').hidden){if(guidance?.dialog.open)return;e.preventDefault();$('libClose').click();} });
})();
