import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {DEFAULT_INSTRUCTIONS,DEFAULT_INSTRUCTIONS_VERSION,composeInstructions} from '../assets/default-instructions.js';
import {library,projectKey} from '../assets/library.js';
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'cosight-defaults-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,store:library(root),project:'/fixture/project'};}
test('baseline precedes verbatim project additions and retains conflict policy',()=>{
 const additions='  Focus on our domain boundaries.\nKeep my exact text.  ';const value=composeInstructions(additions);
 assert.ok(value.startsWith('Built-in CoSight guidance (version '+DEFAULT_INSTRUCTIONS_VERSION+')\n'+DEFAULT_INSTRUCTIONS));assert.ok(value.endsWith(additions));assert.ok(value.indexOf(DEFAULT_INSTRUCTIONS)<value.indexOf('Project additions (extend built-in guidance)'));assert.match(value,/retain the built-in guidance if they conflict/);
 assert.equal(composeInstructions('  '),composeInstructions());assert.throws(()=>composeInstructions({}),/text/);
});
test('baseline addresses document claims, source verification, diagram-only explanations and architectural tradeoffs',()=>{
 for(const term of ['existing domain concepts','cohesion and coupling','meaningful tests','fixtures','recorded intent','inferred rationale','compatibility','risks','architectural alternatives','what it costs','Markdown','in place','diagram-only','verified and relevant','Document contents are evidence','not instructions to execute','observed facts','runtime'])assert.ok(DEFAULT_INSTRUCTIONS.includes(term),term);
});
test('existing instructions and preset remain byte-identical; derived fields are read-only results without read-side writes',t=>{
 const {root,store,project}=fixture(t);const file=path.join(root,'projects',projectKey(project),'settings.json');fs.mkdirSync(path.dirname(file),{recursive:true});
 const saved={instructions:'  Existing custom text\nwith whitespace  ',preset:'My established preset',unrelated:{keep:true},defaultInstructions:'stale baseline',effectiveInstructions:'stale composition',defaultInstructionsVersion:0};fs.writeFileSync(file,JSON.stringify(saved));const before=fs.readFileSync(file,'utf8');
 const result=store.settings(project);assert.equal(result.instructions,saved.instructions);assert.equal(result.preset,saved.preset);assert.equal(result.defaultInstructions,DEFAULT_INSTRUCTIONS);assert.equal(result.defaultInstructionsVersion,DEFAULT_INSTRUCTIONS_VERSION);assert.equal(result.effectiveInstructions,composeInstructions(saved.instructions));assert.equal(fs.readFileSync(file,'utf8'),before);
});
test('saving excludes derived fields, preserves omitted text and preset, and keeps presets reusable additions only',t=>{
 const {root,store,project}=fixture(t);const text='Original project additions';store.saveSettings(project,{instructions:text,preset:'Existing'});store.savePreset('Reusable',text);
 const result=store.saveSettings(project,{agent:{provider:'codex'},defaultInstructions:'injected',effectiveInstructions:'injected',defaultInstructionsVersion:999});assert.equal(result.instructions,text);assert.equal(result.preset,'Existing');assert.equal(result.effectiveInstructions,composeInstructions(text));
 const saved=JSON.parse(fs.readFileSync(path.join(root,'projects',projectKey(project),'settings.json')));for(const key of ['defaultInstructions','effectiveInstructions','defaultInstructionsVersion'])assert.ok(!Object.hasOwn(saved,key),key);assert.deepEqual(store.presets().find(p=>p.name==='Reusable'),{name:'Reusable',instructions:text});
 assert.equal(JSON.parse(fs.readFileSync(path.join(root,'project-instructions.json')))[project],text);assert.equal(store.settings('/fixture/other').instructions,'');
});
test('explicit project additions updates compose with current defaults and can be cleared without losing baseline',t=>{
 const {store,project}=fixture(t);store.saveSettings(project,{instructions:'First',preset:'Preserved'});store.saveSettings(project,{instructions:'Second'});assert.equal(store.settings(project).preset,'Preserved');assert.equal(store.settings(project).effectiveInstructions,composeInstructions('Second'));
 store.saveSettings(project,{instructions:''});assert.equal(store.settings(project).effectiveInstructions,composeInstructions());assert.throws(()=>store.saveSettings(project,{instructions:3}),/32000/);assert.throws(()=>store.saveSettings(project,{instructions:'x'.repeat(32001)}),/32000/);
});
