import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createPluginHost} from '../assets/plugin-host.js';
const [plugin,command]=process.argv.slice(2);
if(!['gitnexus','joern'].includes(plugin)||!command)throw Error('Usage: node tests/plugins-provider-smoke.mjs gitnexus|joern /absolute/executable');
const root=path.resolve('temp',`${plugin}-experiment`),project=path.join(root,'source');
fs.mkdirSync(project,{recursive:true});
const source='def greet(name):\n    print(name)\n\ndef main():\n    greet("CoSight")\n\nmain()\n';
fs.writeFileSync(path.join(project,'main.py'),source);
const host=await createPluginHost({root:path.join(root,'data')});
const records=[];
async function run(tool,input={}){
  const {id}=await host.run({project,plugin,tool,input});
  for(let n=0;n<1300;n++){
    const status=await host.status(project),record=status.results.find(r=>r.id===id);
    if(record){records.push(record);assert.equal(record.state,'done',record.error);return record;}
    await new Promise(r=>setTimeout(r,500));
  }
  throw Error('Experiment timed out');
}
try{
  await host.configure({project,plugin,enabled:true,command:path.resolve(command)});
  if(plugin==='gitnexus'){
    await run('index');const result=await run('context',{query:'greet'});
    assert.match(JSON.stringify(result.result.raw),/greet/);
    assert.match(JSON.stringify(result.result.raw),/main/);
    await run('impact',{query:'greet'});
  }else{
    const record=await run('calls');
    assert.ok(record.result.graph.nodes.some(n=>n.label==='greet'));
    assert.ok(record.result.graph.edges.length>0);
  }
  assert.equal(fs.readFileSync(path.join(project,'main.py'),'utf8'),source);
  assert.equal(fs.existsSync(path.join(project,'AGENTS.md')),false);
  assert.equal(fs.existsSync(path.join(project,'.git')),false);
  fs.mkdirSync('artifacts/verification',{recursive:true});
  fs.writeFileSync(`artifacts/verification/plugins-${plugin}.json`,JSON.stringify({at:new Date().toISOString(),command:path.resolve(command),project,sourceUnchanged:true,gitRequired:false,records},null,2));
  console.log(`PASS: ${plugin} ${records.map(r=>r.tool).join(', ')} against a real Python fixture without Git`);
}finally{await host.close();}
