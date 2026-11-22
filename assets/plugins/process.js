import {spawn} from 'node:child_process';
import {cleanEnvironment} from '../agent-config.js';

// A plugin owns every subprocess it starts. No shell, and cancellation retires the
// process group as well as the launcher (Joern starts a JVM).
export function runProcess(command,args,{cwd,signal,env={},timeout=180000,limit=8*1024*1024,ownGroup=process.platform!=='win32'}={}){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(Error('Analysis cancelled'));
    const child=spawn(command,args,{cwd,env:{...cleanEnvironment(),...env},detached:ownGroup,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',bytes=0,failure;
    const stop=message=>{
      failure=Error(message);
      try{if(!ownGroup)child.kill();else process.kill(-child.pid,'SIGKILL');}catch{}
    };
    const abort=()=>stop('Analysis cancelled');
    const timer=setTimeout(()=>stop('Analysis timed out'),timeout);
    signal?.addEventListener('abort',abort,{once:true});
    for(const [stream,name] of [[child.stdout,'stdout'],[child.stderr,'stderr']])stream.on('data',chunk=>{
      bytes+=chunk.length;
      if(bytes>limit){stop('Analysis output exceeded 8 MB; narrow the analysis');return;}
      if(name==='stdout')stdout+=chunk;else stderr+=chunk;
    });
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
    child.once('error',e=>{cleanup();reject(Error(`Cannot start ${command}: ${e.message}`));});
    child.once('close',code=>{cleanup();failure?reject(failure):code!==0?reject(Error(`${command} exited ${code}: ${stderr.slice(-1600)||stdout.slice(-1600)}`)):resolve({stdout,stderr});});
  });
}
