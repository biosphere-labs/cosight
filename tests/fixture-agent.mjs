// Deterministic test driver for the CLI/MCP seam; no LLM or subscription calls.
import fs from 'node:fs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8')).mcpServers.cosight;
const client=new Client({name:'fixture-driver',version:'1'});
try{
  await client.connect(new StdioClientTransport({...config,env:{...process.env,...config.env}}));
  await client.callTool({name:'plan',arguments:{question:'A standalone agent tour',stops:['Welcome']}});
  const result=await client.callTool({name:'show',arguments:{file:'welcome.js',start:1,end:1,stop:1,title:'Welcome',say:'The welcome function returns hello.',svg:'flowchart LR\n a["Welcome"] --> b["Hello"]'}});
  if(result.isError)throw Error(JSON.stringify(result));
  console.log(JSON.stringify({type:'fixture.complete'}));
}finally{await client.close();}
