import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {cleanEnvironment} from '../agent-config.js';

// A separate process gives hot replacement a termination boundary, even when a
// trusted local tool forgets to observe cancellation. This is not a sandbox.
export function runLocalPlugin(entry,{operation,input={},project,signal,validate=false,timeoutMs=60000}={}){
  if(signal?.aborted)return Promise.reject(Error('Plugin operation cancelled'));
  return new Promise((resolve,reject)=>{
    const ownGroup=process.platform!=='win32';
    const child=fork(fileURLToPath(new URL('./local-worker.js',import.meta.url)),[],{execPath:process.execPath,execArgv:[],env:{...cleanEnvironment(),ELECTRON_RUN_AS_NODE:'1'},detached:ownGroup,stdio:['ignore','ignore','ignore','ipc']});
    let settled=false,result,cancelled=false;
    const kill=()=>{try{if(ownGroup)process.kill(-child.pid,'SIGKILL');else child.kill();}catch{}};
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);kill();error?reject(error):resolve(value);};
    const abort=()=>{cancelled=true;if(child.connected)child.send({cancel:true},()=>{});setTimeout(()=>finish(Error('Plugin operation cancelled')),100);};
    const timer=setTimeout(()=>finish(Error('Local plugin timed out')),timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    child.once('error',error=>finish(error));
    child.on('message',message=>{if(cancelled){finish(Error('Plugin operation cancelled'));return;}if(message?.error)finish(Error(message.error));else if(message?.ok){result=message.value;finish(null,result);}});
    child.once('exit',code=>{if(!settled)finish(Error(`Local plugin exited before returning a result (${code})`));});
    child.send({entry,operation,input,project,validate},error=>{if(error)finish(error);});
    if(signal?.aborted)abort();
  });
}
