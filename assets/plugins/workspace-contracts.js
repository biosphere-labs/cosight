// Shared wire contract for host, first-party adapters and browser UI. Version 1.
export const PLUGIN_API = 1;
export const workspaceCatalog = Object.freeze([
  {id:'git',version:'1.0.0',api:1,title:'Git history',description:'Explore branches, understand changes, and tour source at a specific commit.',capabilities:['repository','history','comparison','source'],view:'git-history'},
  {id:'architecture',version:'1.0.0',api:1,title:'Architecture boundaries',description:'Inspect JS/TS dependency cycles and declared folder boundaries.',capabilities:['analyze','latest','source'],view:'architecture'},
  {id:'diagnostics',version:'1.0.0',api:1,title:'Diagnostic reports',description:'Read existing ESLint and Ruff JSON findings alongside project source.',capabilities:['read','latest','source'],view:'diagnostics'},
  {id:'exercises',version:'1.0.0',api:1,title:'Developer exercises',description:'Source-linked investigations, acceptance criteria and explicit check evidence.',capabilities:['list','create','update','check','cancel'],view:'exercises'},
  {id:'linear',version:'1.0.0',api:1,title:'Linear',description:'Connect issue intent and recorded decisions to your project and branches.',capabilities:['projects','issues','issue','discussion'],view:'linear-context'},
]);
export const gitOperations = Object.freeze(['repository','history','comparison','source']);
export const linearOperations = Object.freeze(['projects','issues','issue','discussion']);
/** @typedef {{sha:string,parents:string[],subject:string,author:string,date:string,refs:string[]}} Commit */
/** @typedef {{name:string,sha:string,kind:string}} Ref */
/** @typedef {{project:string,root:string,head:string|null,currentBranch:string|null,defaultBranch:string|null,refs:Ref[],dirty:boolean,shallow:boolean,empty:boolean}} Repository */
/** @typedef {{commits:Commit[],nextOffset:number|null,truncated:boolean}} History */
/** @typedef {{path:string,oldPath:string|null,status:string}} ChangedFile */
/** @typedef {{repository:string,base:string,head:string,mergeBase:string,mode:string,commits:Commit[],files:ChangedFile[],patch:string,truncated:boolean,warnings:string[]}} Comparison */
/** @typedef {{path:string,revision:string,text:string,binary:boolean}} GitSource */
/** @typedef {{directory:string,revision:string,files:number,omitted:string[]}} GitSnapshot */
/** @typedef {{connected:boolean,state:string,workspace?:object,error?:string}} ConnectionStatus */
/** @typedef {{id:string,identifier:string,title:string,description:string,url:string,retrievedAt:string,comments?:object[]}} IssueEvidence */
/** @typedef {{installed:boolean,enabled:boolean,id:string,version:string,state:string,title:string,description:string}} PluginStatus */
/**
 * HTTP POST /plugins accepts {project,operation,plugin?,input?}.
 * operation: install|enable|disable|remove|replace|call|associate|action|connect|disconnect.
 * GET /plugins?project= returns {project,plugins,views,associations,connection}.
 * call input: {operation: one of gitOperations/linearOperations, ...domain input}.
 * action input: {action:'explain'|'tour',base:string,head:string,mode?:'feature'|'tips',text?:string}.
 * associate input: {workspace?:object|null,project?:object|null,issues?:{id:string,identifier:string,url:string,title:string}[]}.
 * install/replace input: {manifest?:{id,version,api,entry?,capabilities?,view?,title?,description?}};
 * absent manifest installs the curated package version. Local package entries are absolute ESM paths.
 * All failures throw Error; HTTP maps to {error:string}. Absent optional objects use null.
 * Active registrations own cancellation and disappear on disable/remove/replace.
 */
export function validateManifest(value){
  if(!value||typeof value.id!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(value.id))throw Error('Invalid plugin id');
  if(value.api!==PLUGIN_API)throw Error('Plugin requires an incompatible host API');
  if(typeof value.version!=='string'||!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value.version))throw Error('Invalid plugin version');
  if(value.entry!==undefined&&typeof value.entry!=='string')throw Error('Invalid plugin entry');
  return {...value};
}
