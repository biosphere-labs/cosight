// Deterministic CLI/MCP driver, not an LLM or subscription inference test.
import fs from 'node:fs';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const [configPath,runDir]=process.argv.slice(2),config=JSON.parse(fs.readFileSync(configPath,'utf8')).mcpServers.cosight;
const client=new Client({name:'change-ui-fixture',version:'1'});
try{
 await client.connect(new StdioClientTransport({...config,env:{...process.env,...config.env}}));
 const source=await client.callTool({name:'read_source',arguments:{path:'shared.js'}});
 if(source.isError)throw Error(JSON.stringify(source));
 fs.writeFileSync(path.join(runDir,'fixture-source-receipt.json'),JSON.stringify({cwd:process.cwd(),source},null,2));
 await client.callTool({name:'plan',arguments:{question:'Feature revision tour from UI',stops:['Pinned feature source']}});
 const result=await client.callTool({name:'show',arguments:{file:'shared.js',start:1,end:1,stop:1,title:'Pinned feature source',say:'The selected feature revision returns feature, while the working tree remains dirty.',svg:'flowchart LR\n a["Feature revision"] --> b["Pinned source"]'}});
 if(result.isError)throw Error(JSON.stringify(result));
}finally{await client.close();}
