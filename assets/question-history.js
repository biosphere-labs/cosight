import fs from 'node:fs/promises';
import path from 'node:path';

async function readOptional(file) {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

function parseRecord(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function idTime(id) {
  return Number(/(?:^|[-_])(\d{13})$/.exec(id)?.[1]) || 0;
}

async function originalTourQuestion(directory, run) {
  if (typeof run.requestedText === 'string') return run.requestedText;
  // Older CLI runs put the initial question in the final section of prompt.txt.
  const prompt = await readOptional(path.join(directory, 'prompt.txt'));
  const marker = '\n\nTour request: ';
  const instruction = run.documentContext ? 'Use cosight plan then show for ordered sections.' : 'Use the cosight MCP tools to deliver the tour.';
  const tools = prompt.indexOf('\n\n' + instruction, prompt.indexOf(run.effectiveInstructions || '') + (run.effectiveInstructions?.length || 0));
  if (tools < 0) return '';
  const index = prompt.indexOf(marker, tools);
  return index < 0 ? '' : prompt.slice(index + marker.length);
}

export async function questionHistory(root, project, tours) {
  if (!project) return [];
  const rows = new Map();
  const initialText = new Map();
  function add(kind, text, tourId, step, at, answer = null) {
    if (typeof text !== 'string' || !text.trim()) return;
    const key = JSON.stringify([kind, tourId, step, text]);
    const old = rows.get(key);
    rows.set(key, {kind, text, tourId, step, at: Math.max(at, old?.at || 0), answer: answer || old?.answer || null});
  }

  const runs = path.join(root, 'runs');
  let entries;
  try { entries = await fs.readdir(runs, {withFileTypes: true}); }
  catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(runs, entry.name);
    const run = parseRecord(await readOptional(path.join(directory, 'run.json')));
    if (run?.project !== project || !run.tourId) continue;
    const at = Number(entry.name.split('-')[0]) || idTime(run.tourId);
    if (run.kind === 'tour') {
      const text = await originalTourQuestion(directory, run);
      if (text) initialText.set(run.tourId, text);
      add('tour', text, run.tourId, null, at);
    } else if (run.kind === 'question') {
      add('question', run.question, run.tourId, run.from || 1, at);
    }
  }

  const requests = await readOptional(path.join(root, 'requests.jsonl'));
  for (const line of requests.split('\n')) {
    const request = parseRecord(line);
    if (request?.project !== project || !['tour', 'question'].includes(request.kind)) continue;
    add(request.kind, request.text, request.tourId || '', request.kind === 'question' ? request.step || 1 : null, Date.parse(request.at) || 0);
  }
  for (const tour of tours) {
    if (tour.project !== project) continue;
    const at = idTime(tour.tourId);
    const first = tour.stops.reduce((a, b) => !a || b.n < a.n ? b : a, null);
    add('tour', initialText.get(tour.tourId) || tour.question, tour.tourId, null, at, first && {type: 'stop', n: first.n});
    for (const aside of tour.asides) {
      add('question', aside.ask, tour.tourId, aside.from || 1, idTime(aside.id) || at, aside.id && {type: 'aside', id: aside.id});
    }
  }
  return [...rows.values()].sort((a, b) => b.at - a.at);
}
