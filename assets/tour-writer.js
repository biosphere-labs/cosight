import {sourceFiles} from './plugins/worker.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {library} from './library.js';
import {execFileSync} from 'node:child_process';
import {readDocument,readDocumentRange,documentReferenceCandidate} from './document-reader.js';
export function readTour(root){try{return JSON.parse(fs.readFileSync(path.join(root,'tour.json'),'utf8'));}catch{return null;}}
export function writeTour(root,doc){
  library(root).snapshot(readTour(root)); library(root).snapshot(doc);
  const file=path.join(root,'tour.json');fs.mkdirSync(root,{recursive:true});fs.writeFileSync(file+'.part',JSON.stringify(doc));fs.renameSync(file+'.part',file);
}
export function projectDocument(project){return {v:1,tourId:'',project,projectKey:crypto.createHash('sha256').update(project).digest('hex'),question:'',phase:'idle',status:'Choose instructions and an agent to start a tour',plan:[],stops:[],asides:[],mute:{v:0,on:false},speed:{v:0,rate:1}};}
function checkpointSource(config,input){
  const sha=input.revision,resolved=config.documentResolutions?.[sha];
  if(!/^[a-f0-9]{40,64}$/.test(sha)||!resolved)throw Error('Resolve a document reference through document_reference before reading a pinned commit SHA');
  const aliases=resolved.aliases||[resolved],hasRange=input.documentStart!==undefined&&input.documentEnd!==undefined;
  const alias=hasRange?aliases.find(candidate=>candidate.evidence.some(ref=>ref.line>=input.documentStart&&ref.line<=input.documentEnd)):aliases[0];
  if(!alias)throw Error('The checkpoint reference must appear in this stop document range');
  const reference=hasRange?{...alias,evidence:alias.evidence.filter(ref=>ref.line>=input.documentStart&&ref.line<=input.documentEnd)}:alias;
  const name=input.path??input.file;
  if(typeof name!=='string'||!name||name.includes('\\')||name.includes('\0')||path.isAbsolute(name)||/^[a-z]:/i.test(name)||name.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('Source must be inside this project');
  const run=args=>execFileSync('git',['--no-pager','-c','core.fsmonitor=false',...args],{cwd:config.project,encoding:null,timeout:5000,maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_NO_REPLACE_OBJECTS:'1'}});
  const prefix=run(['rev-parse','--show-prefix']).toString().trim(),gitPath=prefix+name;
  const records=run(['ls-tree','--full-tree','-z',sha,'--',gitPath]).toString().split('\0');
  const entry=records.find(row=>row.slice(row.indexOf('\t')+1)===gitPath),match=entry&&/^(100644|100755) blob ([a-f0-9]+)\t/.exec(entry);
  if(!match)throw Error('Requested checkpoint source is not a regular tracked file');
  const size=Number(run(['cat-file','-s',match[2]]).toString());if(size>4*1024*1024)throw Error('Source file is larger than 4 MB');
  const bytes=run(['cat-file','blob',match[2]]);let text;try{if(bytes.includes(0))throw Error();text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw Error('Binary source is not supported');}
  return {path:name,side:'after',revision:sha,text,reference};
}
export function verifyInsightContext(project,context){if(!context)return;for(const [relative,expected] of Object.entries(context.sourceHashes||{})){const file=fs.realpathSync(path.resolve(project,relative)),rel=path.relative(project,file);if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('Analysis source escapes project');if(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==expected)throw Error('Analysis source changed; refresh evidence before continuing');}const evidence=context.evidence;if(evidence?.report&&crypto.createHash('sha256').update(fs.readFileSync(evidence.report.path)).digest('hex')!==evidence.report.hash)throw Error('Diagnostic report changed; reread evidence before continuing');if(evidence?.inventory){const files=sourceFiles(project).files.map(file=>path.relative(project,file).split(path.sep).join('/')).sort();if(JSON.stringify(files)!==JSON.stringify(evidence.inventory))throw Error('Project inventory changed; rerun analysis before continuing');}if(evidence?.changedDuringRun)throw Error('Source changed during analysis; rerun before continuing');}
export function readSource(config,input){
  verifyInsightContext(config.project,config.insightContext);
  if(config.documentContext&&input.revision!==undefined)return checkpointSource(config,input);
  const side=input.side??'after';
  if(!['before','after'].includes(side))throw Error('Source side must be before or after');
  if(side==='before'&&!config.sourceRoots?.before)throw Error('No before source is available');
  const sourceRoot=config.sourceRoots?.[side]||config.project;
  let name=input.path??input.file;
  // Preserve legacy live-file calls with absolute paths inside the project.
  // Historical calls deliberately require paths relative to the pinned snapshot.
  if(!config.sourceRoots&&typeof name==='string'&&path.isAbsolute(name))name=path.relative(fs.realpathSync(sourceRoot),fs.realpathSync(name)).split(path.sep).join('/');
  if(typeof name!=='string'||!name||name.includes('\\')||name.includes('\0')||/^[a-z]:/i.test(name)||(config.changeContext&&path.isAbsolute(name))||(!path.isAbsolute(name)&&name.split('/').some(part=>!part||part==='.'||part==='..')))throw Error('Source must be inside this project');
  const realRoot=fs.realpathSync(sourceRoot),file=fs.realpathSync(path.resolve(realRoot,name)),relative=path.relative(realRoot,file);
  if(relative.startsWith('..'+path.sep)||relative==='..'||path.isAbsolute(relative))throw Error('Source must be inside this project');
  if(config.ephemeralSourcePaths?.[side]?.includes(relative.split(path.sep).join('/')))throw Error('Generated agent configuration is not pinned Git source');
  const stat=fs.statSync(file);if(!stat.isFile())throw Error('Source must be a regular file');
  if(stat.size>4*1024*1024)throw Error('Source file is larger than 4 MB');
  const bytes=fs.readFileSync(file);if(bytes.includes(0))throw Error('Binary source is not supported');
  const comparison=config.changeContext?.comparison;
  return {path:relative.split(path.sep).join('/'),side,revision:comparison?(side==='after'?comparison.head:comparison.mode==='tips'?comparison.base:comparison.mergeBase):null,text:bytes.toString('utf8')};
}
export function tourTools(config){
  const {root,project,tourId,kind,question,from}=config;
  function current(){const doc=readTour(root);if(!doc||doc.project!==project||doc.tourId!==tourId)throw Error('This run is no longer the active tour');return doc;}
  function save(doc){doc.v++;writeTour(root,doc);}
  return {
    insight_context(){if(!config.insightContext)throw Error('No analysis context selected');verifyInsightContext(config.project,config.insightContext);return JSON.stringify(config.insightContext);},
    change_context(){if(!config.changeContext)throw Error('This is not a historical change run');return JSON.stringify(config.changeContext);},
    read_source(input){return JSON.stringify(readSource(config,input));},
    read_document(input){if(!config.documentContext)throw Error('No document is selected for this run');return JSON.stringify(readDocumentRange(project,config.documentContext,input));},
    document_reference(input){if(!config.documentContext)throw Error('No document is selected for this run');return JSON.stringify({...documentReferenceCandidate(project,config.documentContext,input.value),error:'Enable Git history plugin to resolve checkpoint refs'});},
    plan(input){
      if(kind==='question')throw Error('Answer the question as an aside; do not replace the existing route');
      const doc=current();
      if(typeof input.question!=='string'||!Array.isArray(input.stops)||!input.stops.length||input.stops.some(s=>typeof s!=='string'))throw Error('A question and stop titles are required');
      doc.question=input.question;doc.plan=input.stops.map((title,i)=>({n:i+1,title}));doc.stops=[];doc.asides=[];
      if(input.overview)doc.overview={src:input.overview,caption:'Project overview',written:Date.now()};
      doc.phase='writing';doc.status='Writing stop 1';save(doc);return 'Route planned. Now show each stop in order.';
    },
    show(input){
      const doc=current();
      if(kind==='question'){input={...input,ask:question,from};}
      if(typeof input.say!=='string'||!input.say.trim())throw Error('Provide narration');
      let document,source,relative='',file='',text='',lines=0,key='',start=0,end=0;
      if(config.documentContext){
        const snapshot=readDocument(project,config.documentContext.path,{expectedHash:config.documentContext.hash});
        if(typeof input.codeRelevant!=='boolean')throw Error('State whether code is relevant to this document stop');
        const rangeStart=input.documentStart,rangeEnd=input.documentEnd;
        if(!Number.isInteger(rangeStart)||!Number.isInteger(rangeEnd)||rangeStart<1||rangeEnd<rangeStart||rangeEnd>snapshot.text.split('\n').length||rangeEnd-rangeStart>=300)throw Error('Provide an existing document line range of at most 300 lines');
        document={path:snapshot.path,hash:snapshot.hash,start:rangeStart,end:rangeEnd};
        if(typeof input.svg!=='string'||!input.svg.trim())throw Error('Document stops require an explanatory diagram');
        if(!input.codeRelevant&&input.file)throw Error('Diagram-only document stops must omit the source file');
      }
      if(!config.documentContext||input.codeRelevant){
        if(typeof input.file!=='string'||!input.file)throw Error('Provide a source file and narration');
        source=readSource(config,input);relative=source.path;file=relative;text=source.text;lines=text.split('\n').length;
        if(config.documentContext&&(!Number.isInteger(input.start)||!Number.isInteger(input.end)||input.start<1||input.end<input.start||input.start>lines||input.end>lines))throw Error('Provide an actual source line range for relevant code');
        if(document&&source.reference&&!source.reference.evidence.some(ref=>ref.line>=document.start&&ref.line<=document.end))throw Error('The checkpoint reference must appear in this stop document range');
        key=crypto.createHash('sha256').update(text).digest('hex');fs.mkdirSync(path.join(root,'files'),{recursive:true});fs.writeFileSync(path.join(root,'files',key+'.txt'),text);
        start=Math.min(lines,Math.max(1,Math.floor(input.start)||1));end=Math.min(lines,start+79,Math.max(start,Math.floor(input.end)||start));
      }
      const n=Number(input.stop);
      if(!input.ask&&(!Number.isInteger(n)||n<1||n>doc.plan.length))throw Error('Plan first, then show a numbered stop in the route');
      const highlight=(input.highlight||[]).flatMap(r=>Array.from({length:Math.max(0,Math.min(end,Number(r.to??r.from))-Math.max(start,Number(r.from))+1)},(_,i)=>Math.max(start,Number(r.from))+i));
      const entry={...input,id:`${tourId}-${input.ask?'aside-'+Date.now():n}`,n:input.ask?0:n,file:relative,fileUrl:key?`files/${key}.txt`:'',fileLines:lines,lang:path.extname(file).slice(1),start,end,highlight,note:input.note||'',svg:input.svg||'',title:input.title||doc.plan[n-1]?.title||'Answer',mode:input.mode||'split'};
      if(document){entry.document=document;entry.codeRelevant=input.codeRelevant;entry.mode=input.codeRelevant?'split':'map';if(source)entry.source={project,revision:source.revision,side:source.side,...(source.reference?{reference:source.reference}:{})};}
      if(config.changeContext&&source)entry.source={project,repository:config.changeContext.comparison.repository,side:source.side,revision:source.revision};
      if(input.ask){entry.from=Number(input.from)||1;doc.asides.push(entry);}else{doc.stops=doc.stops.filter(s=>s.n!==n).concat(entry).sort((a,b)=>a.n-b.n);}
      doc.status=`Delivered ${doc.stops.length} of ${doc.plan.length} stops`;save(doc);return 'Stop shown. Continue with the next planned stop.';
    },
  };
}
export const planSchema={type:'object',properties:{question:{type:'string'},stops:{type:'array',items:{type:'string'}},overview:{type:'string'}},required:['question','stops']};
export const showSchema={type:'object',properties:{file:{type:'string'},side:{type:'string',enum:['before','after']},start:{type:'integer'},end:{type:'integer'},stop:{type:'integer'},title:{type:'string'},say:{type:'string'},note:{type:'string'},svg:{type:'string'},node:{type:'string'},focus:{type:'array',items:{type:'string'}},highlight:{type:'array',items:{type:'object',properties:{from:{type:'integer'},to:{type:'integer'}},required:['from']}},ask:{type:'string'},from:{type:'integer'},mode:{type:'string'}},required:['file','start','end','say']};

export const documentShowSchema={...showSchema,properties:{...showSchema.properties,codeRelevant:{type:'boolean'},documentStart:{type:'integer'},documentEnd:{type:'integer'},revision:{type:'string',description:'Immutable SHA returned by document_reference'}},required:['say','svg','codeRelevant','documentStart','documentEnd']};
