(async function(){
  const flags=await fetch('features').then(r=>r.json()).catch(()=>({}));
  if(!flags.analysisPlugins)return;
  document.getElementById('bAnalysis').hidden=false;
  const panel=document.createElement('dialog');panel.id='analysisPanel';
  panel.innerHTML='<header><h2>Explore with plugins</h2><button id="analysisClose" aria-label="Close analysis">Close</button></header><p id="analysisProject"></p><p>Choose an analyzer for the question you have. Coverage depends on the plugin and language; Git is optional.</p><div id="analysisPlugins"></div><nav id="analysisViews" aria-label="Analysis views"></nav><div id="analysisTools"></div><p id="analysisMessage" role="status" aria-live="polite"></p><div id="analysisRunning"></div><label>Saved analyses <select id="analysisHistory"></select></label><div id="analysisResult"></div>';
  document.body.append(panel);
  const el=id=>document.getElementById(id);
  let project='',state,view='',timer,selected='',disposed=false,refreshVersion=0;
  async function api(url,input){const r=await fetch(url,input===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});const data=await r.json();if(!r.ok)throw Error(data.error);return data;}
  function message(value){el('analysisMessage').textContent=value;}
  function node(tag,text,parent){const e=document.createElement(tag);if(text)e.textContent=text;if(parent)parent.append(e);return e;}
  function button(text,fn,parent){const b=node('button',text,parent);b.type='button';b.onclick=fn;return b;}
  async function refresh(full=false){
    const version=++refreshVersion,requestedProject=project;
    const next=await api('analysis?project='+encodeURIComponent(requestedProject));
    if(disposed||version!==refreshVersion||requestedProject!==project)return;
    state=next;
    if(full){drawPlugins();drawViews();drawTools();}
    const running=el('analysisRunning');running.replaceChildren();
    for(const job of state.running){const icon=node('img','',running);icon.src='icons/atlas-loading.svg';icon.alt='';icon.width=32;icon.height=32;node('span','Getting things ready · '+job.plugin+' · '+job.tool+' ',running);button('Cancel',async()=>{try{await api('analysis/cancel',{project,id:job.id});await refresh();}catch(e){message(e.message);}},running);}
    drawHistory();
    if(selected){const r=state.results.find(r=>r.id===selected);if(r){await drawResult(r);message(r.state==='done'?'Analysis saved for this project.':r.error||r.state);}}
    clearTimeout(timer);if(panel.open)timer=setTimeout(()=>refresh().catch(e=>message(e.message)),state.running.length?1000:5000);
  }
  function drawHistory(){
    const choices=el('analysisHistory');choices.replaceChildren(new Option('Select an analysis',''));
    for(const result of state.results.filter(r=>!view||r.plugin===view))choices.add(new Option(new Date(result.startedAt).toLocaleString()+' · '+result.tool+' · '+result.state,result.id));
    choices.value=selected;
  }
  function drawPlugins(){
    const list=el('analysisPlugins');list.replaceChildren();
    for(const plugin of state.plugins){
      const item=node('details','',list),heading=node('summary',plugin.title+' · '+plugin.state,item);
      heading.title=plugin.languages.join(', ');
      node('p',plugin.description,item);node('small','Coverage: '+plugin.languages.join(', '),item);
      const label=node('label',' Enabled ',item),toggle=node('input','',label);toggle.type='checkbox';toggle.checked=plugin.enabled;
      let command;
      if(!plugin.bundled){const l=node('label','Executable ',item);command=node('input','',l);command.value=plugin.command;command.placeholder='Executable name or absolute path';}
      button('Apply',async()=>{
        try{message('Applying plugin settings…');await api('analysis/config',{project,plugin:plugin.id,enabled:toggle.checked,...(command?{command:command.value}:{})});await refresh(true);message('Saved plugin settings for this project.');}catch(e){message(e.message);}
      },item);
    }
  }
  function drawViews(){
    const tabs=el('analysisViews');tabs.replaceChildren();
    if(!state.views.some(v=>v.owner===view))view=state.views[0]?.owner||'';
    for(const v of state.views){const b=button(v.title,()=>{view=v.owner;selected='';drawViews();drawTools();drawHistory();el('analysisResult').replaceChildren();el('analysisResult').dataset.record='';},tabs);b.setAttribute('aria-pressed',String(v.owner===view));}
  }
  function drawTools(){
    const target=el('analysisTools');target.replaceChildren();
    for(const tool of state.tools.filter(t=>t.owner===view)){
      const form=node('form','',target),inputs={};node('h3',tool.title,form);
      for(const [key,spec] of Object.entries(tool.inputSchema.properties)){
        const label=node('label',spec.description+' ',form),input=node(spec.enum?'select':'input','',label);
        if(spec.enum)for(const value of spec.enum)input.add(new Option(value,value));
        input.required=true;input.maxLength=2000;inputs[key]=input;
      }
      const run=node('button','Run analysis',form);run.type='submit';run.disabled=!state.plugins.find(p=>p.id===view)?.available;
      form.onsubmit=async event=>{
        event.preventDefault();run.disabled=true;
        try{const job=await api('analysis/run',{project,plugin:tool.owner,tool:tool.id.split('.').at(-1),input:Object.fromEntries(Object.entries(inputs).map(([key,value])=>[key,value.value]))});selected=job.id;message('Analysis started. Results will appear here and remain saved.');await refresh();}catch(e){message(e.message);}finally{run.disabled=false;}
      };
    }
  }
  async function drawResult(record){
    const target=el('analysisResult');
    if(target.dataset.record===record.id)return;
    target.dataset.record=record.id;target.replaceChildren();
    node('h3',record.error||record.result?.summary||record.state,target);
    node('small','Source snapshot time: '+record.startedAt+'. Re-run after source changes.',target);
    if(record.error)return;
    const result=record.result||{};
    for(const warning of result.warnings||[])node('p',warning,target);
    if(result.graph?.nodes?.length){
      const diagram=node('div','',target);diagram.className='analysisDiagram';
      const nodes=result.graph.nodes.slice(0,80),ids=new Map(nodes.map((n,i)=>[n.id,'n'+i]));
      const quote=text=>JSON.stringify(String(text).replace(/[<>]/g,'').replace(/"/g,"'"));
      const lines=['flowchart LR',...nodes.map(n=>ids.get(n.id)+'['+quote(n.label)+']'),...result.graph.edges.filter(e=>ids.has(e.from)&&ids.has(e.to)).slice(0,200).map(e=>ids.get(e.from)+' --> '+ids.get(e.to))];
      getSvg(lines.join('\n'),(error,svg)=>{if(target.dataset.record!==record.id)return;if(error)node('p','The diagram is unavailable. The analysis results are listed below.',diagram);else diagram.innerHTML=svg;});
      node('small','Diagram preview: up to 80 nodes and 200 edges. Full results are below.',target);
    }
    for(const finding of (result.findings||[]).slice(0,100)){
      const item=node('article','',target);node('strong',finding.file+(finding.line?':'+finding.line:''),item);node('pre',finding.text,item);
    }
    const details=node('details','',target);node('summary','Full analysis and provenance',details);node('pre',JSON.stringify(record,null,2),details);
  }
  el('analysisHistory').onchange=()=>{selected=el('analysisHistory').value;el('analysisResult').dataset.record='';el('analysisResult').replaceChildren();const r=state.results.find(r=>r.id===selected);if(r)drawResult(r).catch(e=>message(e.message));};
  el('bAnalysis').onclick=async()=>{
    const next=(liveDoc&&liveDoc.project)||'';
    if(project!==next){selected='';view='';el('analysisResult').replaceChildren();el('analysisResult').dataset.record='';}
    project=next;
    if(!project){el('bLibrary').click();return;}
    disposed=false;panel.showModal();el('analysisProject').textContent=project;message('Loading project plugins…');
    try{await refresh(true);message('');}catch(e){message(e.message);}
  };
  el('analysisClose').onclick=()=>panel.close();
  panel.addEventListener('close',()=>{disposed=true;clearTimeout(timer);});
  panel.addEventListener('keydown',e=>e.stopPropagation());
})();
