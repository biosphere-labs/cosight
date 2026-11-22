import fs from 'node:fs';
import path from 'node:path';

function readText(file,max=65536){
  const fd=fs.openSync(file,'r');
  try{const buffer=Buffer.alloc(max);const length=fs.readSync(fd,buffer,0,max,0);return buffer.subarray(0,length).toString('utf8');}finally{fs.closeSync(fd);}
}
export function projectOverview(project,root){
  if(root){try{const notes=JSON.parse(fs.readFileSync(path.join(root,'project-overviews.json'),'utf8'))[project];if(notes)return {...projectOverview(project),...notes,source:'Project notes supplied by you'};}catch{}}

  const fallback={name:project?path.basename(project):'Choose a project',description:'',readme:null,entries:[]};
  if(!project)return fallback;
  try{
    const directory=fs.realpathSync(project);
    if(!fs.statSync(directory).isDirectory())throw Error('The project folder is not a directory');
    const entries=fs.readdirSync(directory,{withFileTypes:true}).filter(e=>!e.name.startsWith('.')&&!['node_modules','dist','build','temp','coverage'].includes(e.name));
    let manifest={};
    try{manifest=JSON.parse(readText(path.join(directory,'package.json')));}catch{}
    const readme=entries.find(e=>e.isFile()&&/^readme(?:\.md|\.markdown|\.rst|\.txt)?$/i.test(e.name));
    let excerpt='',paragraphs=[],title='';
    if(readme){
      const file=path.join(directory,readme.name),real=fs.realpathSync(file);
      if(path.dirname(real)===directory){
        const source=readText(real,16000);
        title=source.match(/^#\s+(.+)$/m)?.[1]||'';
        const plain=source.replace(/```[\s\S]*?```/g,'').replace(/~~~[\s\S]*?~~~/g,'');
        paragraphs=plain.split(/\n\s*\n/).map(p=>p.trim()).filter(p=>p&&!/^(?:#|[![<|]|[-*]\s|\d+\.)/.test(p)).slice(0,3).map(p=>p.replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/[*`]/g,'').replace(/\s+/g,' ').slice(0,650));
        excerpt=source.slice(0,6000);
      }
    }
    return {...fallback,name:title||manifest.name||fallback.name,description:typeof manifest.description==='string'?manifest.description:'',paragraphs,readme:excerpt?{file:readme.name,excerpt}:null,entries:entries.slice(0,24).map(e=>({name:e.name,directory:e.isDirectory()}))};
  }catch(e){return {...fallback,error:'This folder is unavailable. Choose its current location to explore it. Saved tours remain available.'};}
}

export function recentProjects(root,store,current){
  const projects=new Set(current?[current]:[]),directory=path.join(root,'projects');
  for(const name of fs.existsSync(directory)?fs.readdirSync(directory):[]){
    try{const settings=JSON.parse(fs.readFileSync(path.join(directory,name,'settings.json'),'utf8'));if(settings.project)projects.add(settings.project);}catch{}
  }
  for(const tour of store.history(''))if(tour.project)projects.add(tour.project);
  let hidden=[];try{hidden=JSON.parse(fs.readFileSync(path.join(root,'hidden-projects.json'),'utf8'));}catch{}
  return [...projects].filter(project=>!hidden.includes(project)).map(project=>({path:project,name:path.basename(project)}));
}
