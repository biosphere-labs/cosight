import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {questionHistory} from '../assets/question-history.js';

test('recovers original questions from older runs and links archived answers without leaking instructions or other projects', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cosight-history-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const project = '/river', tourId = 't-1793470000000';
  const directory = path.join(root, 'runs', '1793470000000-first');
  fs.mkdirSync(directory, {recursive:true});
  const guidance = 'Private instructions\n\nTour request: example only';
  fs.writeFileSync(path.join(directory, 'run.json'), JSON.stringify({project,tourId,kind:'tour',effectiveInstructions:guidance}));
  const text = 'Why does the parser use this header?\n\nTour request: example';
  fs.writeFileSync(path.join(directory, 'prompt.txt'), guidance+'\n\nUse the cosight MCP tools to deliver the tour. More instructions.\n\nTour request: '+text);
  const aside = {id:'s-aside-1793472000000',ask:'Which parser?',from:2};
  const tours = [{project,tourId,question:'Agent title',stops:[{n:2},{n:1}],asides:[aside]}];
  const requests = [{project,tourId,kind:'question',step:2,text:aside.ask}, {project:'/other',kind:'question',text:'Private question'}, {kind:'question',text:'Unattributed'}];
  fs.writeFileSync(path.join(root, 'requests.jsonl'), requests.map(r=>JSON.stringify(r)).join('\n'));
  const result = await questionHistory(root, project, tours);
  assert.deepEqual(result.map(row=>row.text), [aside.ask,text]);
  assert.deepEqual(result.map(row=>row.answer), [{type:'aside',id:aside.id},{type:'stop',n:1}]);
  fs.writeFileSync(path.join(directory,'prompt.txt'), guidance);
  assert.equal((await questionHistory(root,project,tours))[1].text,'Agent title');
  assert.deepEqual(await questionHistory(root,'',tours),[]);
});
