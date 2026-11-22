// Shared optional-plugin wire contract, API 1. Errors throw; missing evidence is null.
export const optionalIds=Object.freeze(['architecture','diagnostics','exercises']);
export const optionalOperations=Object.freeze({architecture:['analyze','latest','source'],diagnostics:['read','latest','source'],exercises:['list','create','update','check','cancel']});
export const agentOperations=Object.freeze({architecture:['latest','source'],diagnostics:['latest','source'],exercises:['list']});
/** @typedef {{file:string,line:number|null,endLine:number|null,column?:number|null,endColumn?:number|null,fileLevel?:boolean,hash:string|null,missing:boolean}} EvidenceLocation */
/** @typedef {{id:string,rule:string,severity:string,message:string,locations:EvidenceLocation[],cycle?:string[],cycleEdges?:Array<{from:string,to:string,kind:string}>,rawRecordIndex?:number,rawMessageIndex?:number|null,rawDiagnostic?:object}} Finding */
/** @typedef {{id:string,provider:string,createdAt:string,revision:string|null,sourceHashes:Object,findings:Finding[],warnings:string[],stale:boolean,graph?:Object}} Evidence */
/** @typedef {{id:string,title:string,objective:string,criteria:string[],locations:EvidenceLocation[],link:string,status:string,notes:string,checks:Object[],createdAt:string,updatedAt:string}} Exercise */
export const checkPresets=Object.freeze({npmTest:{title:'npm test',command:'npm',args:['test']},npmCheck:{title:'npm run check',command:'npm',args:['run','check']},pytest:{title:'python -m pytest',command:'python3',args:['-m','pytest']},dotnet:{title:'dotnet test',command:'dotnet',args:['test']},maven:{title:'mvn test',command:'mvn',args:['test']}});
