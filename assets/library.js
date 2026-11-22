// Durable project settings and tour snapshots. No database or service required.
import fs from 'node:fs';
import {DEFAULT_INSTRUCTIONS,DEFAULT_INSTRUCTIONS_VERSION,composeInstructions} from './default-instructions.js';
import {STARTER_PRESETS} from './starter-presets.js';
import {validateConfig,defaultAgent,defaultSerena} from './agent-config.js';
import path from 'node:path';
import crypto from 'node:crypto';
export const projectKey = project => crypto.createHash('sha256').update(project).digest('hex');
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.part', JSON.stringify(value, null, 2));
  fs.renameSync(file + '.part', file);
};
export function library(root) {
  const settingsFile = project => path.join(root, 'projects', projectKey(project), 'settings.json');
  return {
    guidance() {
      const saved=read(path.join(root,'guidance.json'),null);
      const text=typeof saved?.text==='string'&&saved.text.trim()&&saved.text.length<=32000?saved.text:DEFAULT_INSTRUCTIONS;
      return {text,factoryText:DEFAULT_INSTRUCTIONS,version:DEFAULT_INSTRUCTIONS_VERSION,customized:text!==DEFAULT_INSTRUCTIONS,hash:crypto.createHash('sha256').update(text).digest('hex')};
    },
    saveGuidance(input) {
      if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Enter guidance text');
      const text=input.reset===true?DEFAULT_INSTRUCTIONS:input.text;
      if(typeof text!=='string'||!text.trim()||text.length>32000)throw Error('Enter shared guidance (1–32000 characters)');
      const file=path.join(root,'guidance.json');
      if(text===DEFAULT_INSTRUCTIONS){if(fs.existsSync(file))fs.unlinkSync(file);}else write(file,{text,factoryVersion:DEFAULT_INSTRUCTIONS_VERSION});
      return this.guidance();
    },
    agentPreferences() {
      const saved=read(path.join(root,'agent-preferences.json'),null);
      if(saved)return validateConfig(saved);
      // Reuse the newest previously saved CLI setup when upgrading from the
      // project-only format. Reading preferences never overwrites old settings.
      const directory=path.join(root,'projects');
      const candidates=(fs.existsSync(directory)?fs.readdirSync(directory):[]).flatMap(name=>{
        const file=path.join(directory,name,'settings.json'),value=read(file,null);
        return value?.agent?.provider&&value.agent.provider!=='external'?[{value,modified:fs.statSync(file).mtimeMs}]:[];
      }).sort((a,b)=>b.modified-a.modified);
      return validateConfig(candidates[0]?.value||{agent:defaultAgent,serena:defaultSerena});
    },
    saveAgentPreferences(input) {
      const value=validateConfig({...this.agentPreferences(),...input});
      write(path.join(root,'agent-preferences.json'),value);
      return value;
    },
    setupStatus() {
      if(this.agentPreferences().agent.provider!=='external')return {configured:true};
      if(read(path.join(root,'setup.json'),{}).configured) return {configured:true};
      const projects=path.join(root,'projects');
      for(const name of fs.existsSync(projects)?fs.readdirSync(projects):[]){
        const settings=read(path.join(projects,name,'settings.json'),{});
        if(settings.agent?.provider && settings.agent.provider!=='external') return {configured:true};
      }
      return {configured:false};
    },
    settings(project) {
      const settings={instructions:'',preset:'',...read(settingsFile(project), {}),...this.agentPreferences()};
      const guidance=this.guidance();
      return {...settings,defaultInstructions:guidance.text,factoryInstructions:guidance.factoryText,defaultInstructionsVersion:guidance.version,guidanceHash:guidance.hash,guidanceCustomized:guidance.customized,effectiveInstructions:composeInstructions(settings.instructions,guidance.text)};
    },
    saveSettings(project, settings) {
      if (!project || !settings || typeof settings!=='object' || Array.isArray(settings)) throw Error('Choose a project and enter settings');
      const {defaultInstructions:ignoredDefault,effectiveInstructions:ignoredEffective,defaultInstructionsVersion:ignoredVersion,factoryInstructions:ignoredFactory,guidanceHash:ignoredHash,guidanceCustomized:ignoredCustom,...previous}=this.settings(project);
      const {defaultInstructions:inputDefault,effectiveInstructions:inputEffective,defaultInstructionsVersion:inputVersion,factoryInstructions:inputFactory,guidanceHash:inputHash,guidanceCustomized:inputCustom,...input}=settings;
      const instructions=Object.hasOwn(input,'instructions')?input.instructions:previous.instructions;
      if(typeof instructions!=='string'||instructions.length>32000)throw Error('Enter at most 32000 characters');
      const value = {...previous,project,instructions,preset:Object.hasOwn(input,'preset')?String(input.preset||''):previous.preset,...validateConfig({...previous,...input})};
      if(Object.hasOwn(settings,'agent')||Object.hasOwn(settings,'serena'))this.saveAgentPreferences(value);
      write(settingsFile(project), value);
      write(path.join(root,'setup.json'),{configured:true});
      const indexFile = path.join(root, 'project-instructions.json');
      const index = read(indexFile, {}); index[project] = value.instructions; write(indexFile, index); return this.settings(project);
    },
    presets() { const saved=read(path.join(root,'presets.json'),[]);const users=Array.isArray(saved)?saved:[];const names=new Set(users.map(p=>p.name));return [...users,...STARTER_PRESETS.filter(p=>!names.has(p.name)).map(p=>({...p,source:'example'}))]; },
    savePreset(name, instructions) {
      if (typeof name !== 'string' || !name.trim() || name.length > 100 || typeof instructions !== 'string' || instructions.length > 32000) throw Error('Preset needs a name and instructions (maximum 32000 characters)');
      const presets = read(path.join(root,'presets.json'),[]).filter(p => p.name !== name.trim());
      presets.push({ name: name.trim(), instructions }); write(path.join(root, 'presets.json'), presets); return this.presets();
    },
    snapshot(doc) {
      if (!doc?.tourId || !doc.project || !doc.stops?.length) return;
      const id = crypto.createHash('sha256').update(doc.project + '\n' + doc.tourId).digest('hex');
      write(path.join(root, 'tours', `snapshot-${id}.json`), doc);
    },
    history(project) {
      const dir = path.join(root, 'tours');
      const docs = new Map();
      for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        if (!name.endsWith('.json')) continue;
        const doc = read(path.join(dir, name), null);
        if (!doc || !Array.isArray(doc.stops) || !Array.isArray(doc.asides) || !doc.tourId || (project && doc.project !== project)) continue;
        const key = (doc.project || '') + '\n' + doc.tourId;
        const old = docs.get(key);
        if (!old || (doc.v || 0) >= (old.v || 0)) docs.set(key, doc);
      }
      return [...docs.values()].sort((a,b) => Number(b.tourId.replace(/^t-/, '')) - Number(a.tourId.replace(/^t-/, '')));
    },
  };
}
