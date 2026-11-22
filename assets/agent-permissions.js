import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
export const serenaReadTools=['initial_instructions','get_current_config','check_onboarding_performed','list_dir','find_file','read_file','search_for_pattern','get_symbols_overview','find_symbol','find_referencing_symbols','read_memory','list_memories'];
export const antigravityRules=['mcp(cosight/plan)','mcp(cosight/show)','mcp(cosight/change_context)','mcp(cosight/insight_context)','mcp(cosight/read_source)','mcp(cosight/read_document)','mcp(cosight/document_reference)',...serenaReadTools.map(name=>`mcp(serena/${name})`)];
// Called only by the explicit settings button. Preserves all deny/ask rules and other settings.
export function enableAntigravity(file=path.join(os.homedir(),'.gemini/antigravity-cli/settings.json')){
  const exists=fs.existsSync(file);const original=exists?fs.readFileSync(file,'utf8'):'{}';
  const settings=JSON.parse(original);const previous=settings.permissions?.allow||[];
  if(!Array.isArray(previous))throw Error('Antigravity permissions.allow must be an array');
  const missing=antigravityRules.filter(rule=>!previous.includes(rule));
  if(!missing.length)return {changed:false,path:file};
  const backup=exists?`${file}.cosight-backup-${Date.now()}`:null;
  if(backup)fs.writeFileSync(backup,original,{mode:0o600});
  settings.permissions={...settings.permissions,allow:[...previous,...missing]};
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.cosight-part',JSON.stringify(settings,null,2),{mode:0o600});fs.renameSync(file+'.cosight-part',file);
  return {changed:true,path:file,backup,added:missing};
}
