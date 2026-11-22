// An explicit live subscription run. No API keys. One small fixture project, one provider at a time.
import fs from 'node:fs';import path from 'node:path';
import {defaultSerena} from '../assets/agent-config.js';
import {library} from '../assets/library.js';import {AgentRunner} from '../assets/agent-runner.js';import {readTour} from '../assets/tour-writer.js';
const provider=process.argv[2]||'codex';
const root=path.resolve('temp/provider-smoke-'+provider),project=path.join(root,'project');fs.mkdirSync(project,{recursive:true});
fs.writeFileSync(path.join(project,'main.py'),'def normalize(value):\n    return max(0, value)\n\ndef total(values):\n    return sum(normalize(v) for v in values)\n\ndef run():\n    return total([1, -2, 3])\n');
library(root).saveSettings(project,{instructions:'Use exactly one stop. Explain how run calls total, which calls normalize. Trace references using Serena and show main.py lines 1 to 8. No other work.',agent:{provider},serena:defaultSerena});
const runner=new AgentRunner(root);
try{
 const result=await runner.start({project,text:'Explain the run -> total -> normalize execution path in one spoken stop.'});console.log(JSON.stringify(result));
 while(runner.active){await new Promise(r=>setTimeout(r,1000));}
 const doc=readTour(root);console.log(JSON.stringify({status:doc.status,stops:doc.stops.length,agentRun:doc.agentRun},null,2));
 if(doc.agentRun?.error||!doc.stops.length||!doc.agentRun?.serenaUsed)process.exitCode=1;
}catch(e){console.error(e.message);process.exitCode=1;}
