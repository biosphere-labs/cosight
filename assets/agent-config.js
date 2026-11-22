import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
export const SERENA_REV = 'ede329aaf0c824bea75455a2926f01420d7aa620';
export const defaultAgent = { provider: 'external', command: '', model: '', args: [] };
export const defaultSerena = { enabled: true, command: 'uvx', args: ['--from', `git+https://github.com/oraios/serena@${SERENA_REV}`, 'serena', 'start-mcp-server', '--context', 'agent', '--agent-interface', 'tools', '--mode', 'planning', '--open-web-dashboard', 'false', '--project', '{project}'] };
export function cleanEnvironment(source=process.env){
  return Object.fromEntries(Object.entries(source).filter(([key,value]) => value!==undefined && !/(API_KEY|BASE_URL|AUTH_TOKEN|ACCESS_TOKEN)$/.test(key) && !/^(ANTHROPIC|OPENAI|GOOGLE|GEMINI|VERTEX|AWS_BEARER_TOKEN|CLAUDE_CODE_USE|CLAUDECODE|CODEX_THREAD_ID|AGY_LLM_GATEWAY|AGY_ADC_AUTH|AGY_BUSINESS_PAYGO_TIER)/.test(key)));
}
export function binary(command, env=process.env){
  if(path.isAbsolute(command)) return command;
  const paths=[...(env.PATH||'').split(path.delimiter),path.join(os.homedir(),'.local/bin'),'/opt/homebrew/bin','/usr/local/bin','/usr/bin', '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS'];
  const names=process.platform==='win32'?[command,command+'.exe',command+'.cmd']:[command];
  for(const dir of paths) for(const name of names){const file=path.join(dir,name);try{fs.accessSync(file,fs.constants.X_OK);return file;}catch{}}
  return command;
}
export function validateConfig(value){
  const agent={...defaultAgent,...value.agent}; const serena={...defaultSerena,...value.serena};
  if(!['external','claude','codex','antigravity','custom'].includes(agent.provider)) throw Error('Unknown agent provider');
  for(const config of [agent,serena]){
    if(typeof config.command!=='string' || !Array.isArray(config.args) || config.args.some(a=>typeof a!=='string') || config.args.length>100) throw Error('Command must be text and arguments a JSON array of strings');
  }
  if(typeof agent.model!=='string' || typeof serena.enabled!=='boolean') throw Error('Invalid model or Serena setting');
  if(serena.enabled&&!serena.command.trim())throw Error('Set the Serena executable');
  if(agent.provider==='custom'&&!agent.command.trim()) throw Error('Set the custom agent executable');
  return {agent,serena};
}
export const expand = (args,values) => args.map(arg=>arg.replace(/\{(prompt|project|mcpConfig|runDir|model)\}/g,(_,key)=>values[key]||''));
export function invocation(agent, values, servers){
  const model=agent.model?['--model',agent.model]:[];
  if(agent.provider==='claude') return {command:agent.command||'claude',args:['-p',values.prompt,'--output-format','stream-json','--verbose','--setting-sources','','--strict-mcp-config','--mcp-config',values.mcpConfig,'--permission-mode','dontAsk','--tools','Read,Glob,Grep','--allowedTools','mcp__cosight__*,mcp__serena__*,Read,Glob,Grep',...model]};
  if(agent.provider==='codex'){
    const configs=['forced_login_method="chatgpt"','model_provider="openai"','mcp_servers.cosight.tools.plan.approval_mode="approve"','mcp_servers.cosight.tools.show.approval_mode="approve"','mcp_servers.cosight.tools.insight_context.approval_mode="approve"','mcp_servers.cosight.tools.read_document.approval_mode="approve"','mcp_servers.cosight.tools.document_reference.approval_mode="approve"'];
    for(const [name,server] of Object.entries(servers)){
      configs.push(`mcp_servers.${name}.command=${JSON.stringify(server.command)}`,`mcp_servers.${name}.args=${JSON.stringify(server.args)}`,`mcp_servers.${name}.required=true`,`mcp_servers.${name}.startup_timeout_sec=120`);
      for(const [key,value] of Object.entries(server.env||{})) configs.push(`mcp_servers.${name}.env.${key}=${JSON.stringify(value)}`);
    }
    return {command:agent.command||'codex',args:['exec','--ignore-user-config','--sandbox','read-only','--skip-git-repo-check','--json',...configs.flatMap(c=>['-c',c]),...model,values.prompt]};
  }
  // Antigravity discovers the ephemeral run workspace's .agents/mcp_config.json.
  if(agent.provider==='antigravity') return {command:agent.command||'agy',args:['-p',values.prompt,'--output-format','stream-json','--mode','plan','--add-dir',values.project,...model]};

  if(agent.provider==='custom') return {command:agent.command,args:expand(agent.args,values)};
  throw Error('Select a CLI agent to run a standalone tour');
}

// Detection establishes executable availability only, not authentication or tool access.
export function availableAgents(agent=defaultAgent,env=process.env){
  return [['codex','Codex','codex'],['claude','Claude','claude'],['antigravity','Antigravity','agy']].map(([id,title,command])=>{
    const executable=binary(agent.provider===id&&agent.command?agent.command:command,env);let available=false;
    try{fs.accessSync(executable,fs.constants.X_OK);available=fs.statSync(executable).isFile();}catch{}
    return {id,title,available,selected:agent.provider===id,authentication:'not-checked'};
  });
}
