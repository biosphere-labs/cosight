import {pathToFileURL} from 'node:url';
const controller=new AbortController();let started=false;
process.on('message',async message=>{
  if(message.cancel){controller.abort();return;}
  if(started)return;started=true;
  const {entry,operation,input,project,validate}=message;
  try{
    const plugin=await import(pathToFileURL(entry).href);
    if(typeof plugin.execute!=='function')throw Error('Local plugin must export execute(operation, input, context)');
    const value=validate?null:await plugin.execute(operation,input,{project,signal:controller.signal});
    const serialized=JSON.stringify(value??null);
    if(Buffer.byteLength(serialized)>8*1024*1024)throw Error('Local plugin result exceeds 8 MB');
    process.send({ok:true,value:JSON.parse(serialized)});
  }catch(error){process.send({error:error.message});}
});
