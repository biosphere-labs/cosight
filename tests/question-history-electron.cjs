const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');

async function check() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cosight-questions-')));
  const project = path.join(root, 'River'), other = path.join(root, 'Forest');
  const original = 'Where does the river start?', followup = 'What calls the welcome function?';
  const archive = {project, tourId:'t-1793470000000', v:1, question:'A legacy question?', phase:'done',
    plan:[{n:1,title:'Source'}], stops:[{id:'s1',n:1,title:'Source',say:'Saved answer.'}], asides:[]};
  fs.mkdirSync(project); fs.mkdirSync(other); fs.mkdirSync(path.join(root, 'tours'));
  fs.writeFileSync(path.join(project, 'welcome.js'), 'function welcome() { return "hello"; }');
  fs.writeFileSync(path.join(root, 'tour.json'), JSON.stringify(archive));
  fs.writeFileSync(path.join(root, 'tours', 'other.json'), JSON.stringify({...archive, project:other, question:'Forest only?'}));
  fs.writeFileSync(path.join(root, 'requests.jsonl'), JSON.stringify({project, kind:'question', text:'An unanswered question?', step:1, at:new Date().toISOString()})+'\n');
  const socket = net.createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const base = 'http://127.0.0.1:'+port;
  let app, page;
  const errors = [];
  async function launch() {
    app = await electron.launch({timeout:45000,...(process.env.COSIGHT_TEST_APP ? {executablePath:process.env.COSIGHT_TEST_APP,args:[]} : {args:['.']}),
      env:{...process.env,COSIGHT_DATA_DIR:root,COSIGHT_PORT:String(port),COSIGHT_USER_DATA_DIR:path.join(root,'profile'),KOKORO_ENSURE:''}});
    page = await app.firstWindow({timeout:45000});
    page.setDefaultTimeout(30000);
    page.on('pageerror', e => errors.push(e.message));
    await page.locator('#homePicker').waitFor();
    await page.evaluate(() => localStorage.setItem('cosight:voiceEngine', JSON.stringify('kokoro')));
    await page.reload();
    await pick(project);
  }
  async function stop() {
    const identity = await fetch(base+'/whoami').then(r => r.json()).catch(() => null);
    await app?.close(); app = null;
    if (identity?.root === root) {
      process.kill(identity.pid, 'SIGTERM');
      for (let n=0; n<50; n++) {
        try { await fetch(base+'/whoami'); } catch { break; }
        await new Promise(resolve=>setTimeout(resolve,50));
      }
    }
  }
  async function pick(projectPath) {
    await page.locator('#homeRecent button').filter({hasText:projectPath}).click();
    await page.waitForFunction(p=>document.getElementById('homeProjectPath').textContent===p, projectPath);
  }
  async function history() {
    await page.getByRole('button', {name:'Previous questions',exact:true}).click();
    const dialog = page.getByRole('dialog', {name:'Previous questions'});
    await dialog.locator('input:enabled').waitFor();
    return dialog;
  }
  const row = (dialog, text) => dialog.getByRole('listitem').filter({hasText:text});
  try {
    await launch();
    const setup = await fetch(base+'/settings', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      project, agent:{provider:'custom',command:process.execPath,args:[path.resolve('tests/fixture-agent.mjs'),'{mcpConfig}']},serena:{enabled:false}})});
    assert.equal(setup.status,200);
    let dialog = await history();
    assert.equal(await row(dialog,'Forest only?').count(),0);
    await row(dialog,archive.question).getByRole('button',{name:'View answer'}).click();
    await page.waitForFunction(()=>reviewingArchive && cur?.n===1 && shownId==='s1');
    dialog = await history();
    assert.equal(await row(dialog,'An unanswered question?').getByText('View answer').count(),0);
    await row(dialog,'An unanswered question?').getByText('Use question').click();
    await page.waitForFunction(()=>CoSightHome.visible() && document.activeElement.id==='askin');
    assert.equal(await page.locator('#askin').inputValue(),'An unanswered question?');
    assert.ok(!fs.existsSync(path.join(root,'runs')));
    await page.locator('#askin').fill(original); await page.locator('#bSend').click();
    await page.waitForFunction(()=>!CoSightHome.visible() && doc.question==='A standalone agent tour' && doc.phase==='done');
    await page.locator('#askin').fill(followup); await page.locator('#askin').press('Enter');
    await page.waitForFunction(q=>doc.asides.some(a=>a.ask===q) && doc.phase==='done',followup);
    dialog = await history();
    await row(dialog,original).getByText('Use question').click();
    assert.equal(await page.locator('#askin').inputValue(),original);
    await stop();
    await launch();
    dialog = await history();
    await dialog.getByRole('searchbox').fill('WELCOME');
    assert.equal(await dialog.getByRole('listitem').count(),1);
    await row(dialog,followup).getByText('View answer').click();
    await page.waitForFunction(q=>reviewingArchive && cur?.type==='aside' && curEntry()?.ask===q && paused,followup);
    assert.match(await page.locator('#note').innerText(),/welcome function returns hello/i);
    const liveBefore=fs.readFileSync(path.join(root,'tour.json'),'utf8');
    dialog=await history();
    await dialog.getByRole('searchbox').fill(archive.question);
    await row(dialog,archive.question).getByText('View answer').click();
    await page.waitForFunction(()=>reviewingArchive && shownId==='s1');
    const archivedQuestion='Why does this saved step return hello?';
    const field=page.locator('#askin');
    await field.fill(archivedQuestion);
    await page.route('**/request',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'An agent is already running'})}),{times:1});
    await field.press('Enter');
    await page.getByText('An agent is already running',{exact:true}).waitFor();
    assert.equal(await field.inputValue(),archivedQuestion);
    await page.locator('#bSend').click();
    await page.waitForFunction(q=>reviewingArchive && curEntry()?.ask===q && doc.phase==='done',archivedQuestion);
    assert.equal(await field.inputValue(),'');
    assert.equal(await page.evaluate(()=>curEntry().from),1);
    assert.equal(fs.readFileSync(path.join(root,'tour.json'),'utf8'),liveBefore);
    await stop();await launch();
    dialog=await history();
    await row(dialog,archivedQuestion).getByText('View answer').click();
    await page.waitForFunction(q=>reviewingArchive && curEntry()?.ask===q,archivedQuestion);
    await page.locator('#bHome').click();
    await page.locator('#homeSwitch').click(); await pick(other);
    dialog = await history();
    assert.equal(await dialog.getByRole('listitem').count(),1);
    assert.match(await dialog.getByRole('listitem').innerText(),/Forest only/);
    assert.equal(fs.readdirSync(path.join(root,'runs')).length,3);
    assert.deepEqual(errors,[]);
    console.log('Passed Electron questions: live and saved-tour follow-ups, retained draft after rejection, original step and answer after restart, untouched live tour, and project isolation.');
  } finally {
    await stop();
    fs.rmSync(root,{recursive:true,force:true});
  }
}
check().catch(error=>{console.error(error);process.exitCode=1;});
