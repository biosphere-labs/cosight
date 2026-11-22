// Versioned boundary shared by document reader, HTTP host and browser viewer.
export const DOCUMENT_API=1;
export const documentRoutes=Object.freeze({list:'/documents',read:'/documents/read',select:'/documents/select',start:'/documents/start'});
/** @typedef {{title:string,line:number,endLine:number}} DocumentSection */
/** @typedef {{value:string,line:number,kind:string}} DocumentReference */
/** @typedef {{project:string,path:string,title:string,text:string,hash:string,modifiedAt:string,size:number,sections:DocumentSection[],references:DocumentReference[]}} DocumentSnapshot */
/**
 * GET /documents?project= => {project,documents:[{path,title,modifiedAt,size}],selectedPath:string|null}.
 * GET /documents/read?project=&path= => DocumentSnapshot (rereads source, never imports).
 * POST /documents/select {project,path} => DocumentSnapshot, persists path metadata only.
 * POST /documents/start {project,path,hash?,text?} => existing AgentRunner start result.
 * POST /documents/reference {project,path,hash?,value}; optional hash pins the displayed preview.
 * AgentRunner.start({project,text,documentContext:{path,hash}}) binds a source document.
 * MCP read_document({start?,end?}) returns bounded document lines and metadata;
 * document_reference({value}) resolves a document-mentioned Git ref to immutable SHA/parents or reports unresolved.
 * Document-mode show accepts {say,stop,title,svg,documentStart?,documentEnd?,codeRelevant:boolean,
 * file?,start?,end?,revision?,note?}. Relevant code requires a real file+lines; revision, if given,
 * is a pinned commit SHA. No relevant code requires an explanatory svg and no source file;
 * saved entry has codeRelevant:false, document provenance, fileUrl:'', mode:'map'.
 * Existing source tour show contract remains compatible when no documentContext exists.
 */
export function isDocumentSnapshot(value){return !!value&&typeof value.path==='string'&&typeof value.text==='string'&&typeof value.hash==='string'&&Array.isArray(value.sections)&&Array.isArray(value.references);}
