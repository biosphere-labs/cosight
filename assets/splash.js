// One Atlas visual for first-run setup, startup, and non-blocking background loads.
(function(){
  var known=false,needsSetup=false,dismissed=false,current=window.doc||null;
  var jobs=new Map(),sequence=0,jobTimer=null,configRequest=null;
  var panel=document.getElementById('splash');
  function display(mode,title,message){
    panel.hidden=false;panel.className=mode;
    $('splashTitle').textContent=title;$('splashMessage').textContent=message;
    $('splashSkip').hidden=mode!=='welcome';
    $('splashStop').hidden=mode!=='loading'||!current||!current.agentStatus?.running;
    $('splashSetup').textContent=mode==='welcome'?'Set up agents & providers':'Agents & providers';
  }
  function refresh(){
    var libraryOpen=!$('library').hidden;
    // The home page owns first-run setup and project selection. Loading never
    // hides its overview, question box or saved tours.
    if(document.body.classList.contains('home-mode')){panel.hidden=true;return;}
    if(libraryOpen){
      if(jobs.size)display('compact','',Array.from(jobs.values()).at(-1));else panel.hidden=true;
      return;
    }
    if(!current&&!dismissed){display('loading','Getting your bearings','Connecting to your local workspace…');return;}
    var busy=current&&/^(reading|writing|answering)$/.test(current.phase);
    if(busy&&!window.reviewingArchive){
      var hasContent=(current.stops||[]).length>0;
      display(hasContent?'compact':'loading','Exploring your codebase',current.status||'Following the paths through your code…');return;
    }
    if(jobs.size){display('compact','',Array.from(jobs.values()).at(-1));return;}
    panel.hidden=true;
  }
  async function loadConfig(){
    if(configRequest)return configRequest;
    configRequest=fetch('library').then(function(r){if(!r.ok)throw Error('Server not ready');return r.json();}).then(function(data){known=true;needsSetup=!data.setup?.configured;refresh();}).catch(function(){
      setTimeout(function(){if(!known)loadConfig();},2000);
      if(!current)display('loading','Waiting for the local server','Your workspace is taking a little longer to connect. You can open setup or wait for it to reconnect.');
    }).finally(function(){configRequest=null;});
    return configRequest;
  }
  window.CoSightSplash={
    begin:function(message){var id=++sequence;clearTimeout(jobTimer);jobTimer=setTimeout(function(){refresh();},220);jobs.set(id,message||'Loading…');return id;},
    end:function(id){jobs.delete(id);if(!jobs.size)clearTimeout(jobTimer);refresh();},
    refresh:refresh,
  };
  $('splashSetup').onclick=async function(){panel.hidden=true;await $('bLibrary').onclick();if(!$('libProjectPath').value)$('libProjectPath').focus();};
  $('splashSkip').onclick=function(){dismissed=true;refresh();};
  $('splashStop').onclick=function(){$('libStopAgent').click();};
  window.addEventListener('cosight:document',function(event){current=event.detail;refresh();if(!known)loadConfig();});
  window.addEventListener('cosight:configured',function(){known=true;needsSetup=false;refresh();});
  document.addEventListener('keydown',function(event){if(event.key==='Escape')setTimeout(refresh,0);});
  loadConfig();refresh();
})();
