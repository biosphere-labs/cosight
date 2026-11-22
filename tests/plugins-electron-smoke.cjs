const {_electron:electron}=require('playwright');
const fs=require('node:fs'),path=require('node:path');
(async()=>{
  const root=path.resolve('temp/plugins-electron'),project=path.join(root,'source');
  fs.rmSync(root,{recursive:true,force:true});fs.mkdirSync(project,{recursive:true});
  fs.writeFileSync(path.join(root,'setup.json'),JSON.stringify({configured:true}));
  fs.writeFileSync(path.join(project,'main.py'),'def greet(name):\n    print(name)\n');
  fs.writeFileSync(path.join(project,'a.js'),'import "./b.js"; console.log("hello");');
  fs.writeFileSync(path.join(project,'b.js'),'import "./a.js";');
  fs.writeFileSync(path.join(root,'tour.json'),JSON.stringify({project,tourId:'',v:1,phase:'idle',stops:[],asides:[],plan:[]}));
  const app=await electron.launch({...(process.env.COSIGHT_TEST_APP?{executablePath:process.env.COSIGHT_TEST_APP,args:[]}:{args:['.']}),env:{...process.env,COSIGHT_EXPERIMENTAL_PLUGINS:'1',COSIGHT_DATA_DIR:root,COSIGHT_USER_DATA_DIR:path.join(root,'profile'),COSIGHT_PORT:'18209',KOKORO_ENSURE:''}});
  let page;
  try{
    page=await app.firstWindow();await page.waitForLoadState('load');const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.waitForFunction(()=>window.liveDoc?.project);
    await page.locator('#homeRecent button').filter({hasText:project}).click();
    // Idle home is covered by the existing startup splash. Dismiss it as a user.
    const splash=page.locator('#splash');if(await splash.isVisible()){const browse=page.locator('#splashBrowse');if(await browse.isVisible())await browse.click();}
    await page.evaluate(()=>{document.getElementById('splash')?.classList.remove('on');document.getElementById('library').hidden=true;});
    await page.locator('#homeExperimental').click();await page.locator('#analysisPanel[open]').waitFor();
    await page.locator('#analysisTools select').selectOption('Python');
    await page.locator('#analysisTools input').fill('print($$$ARGS)');
    await page.getByRole('button',{name:'Run analysis',exact:true}).click();
    await page.getByRole('heading',{name:'1 Python matches in 1 scanned files.'}).waitFor();
    if(!await page.locator('#analysisResult').innerText().then(t=>t.includes('main.py:2')))throw Error('Python source evidence missing');
    await page.locator('#analysisViews').getByRole('button',{name:'Modules',exact:true}).click();
    await page.getByRole('button',{name:'Run analysis',exact:true}).click();
    await page.locator('#analysisResult svg').waitFor();
    await page.screenshot({path:'temp/plugins-electron.png',fullPage:true});
    const summary=await page.locator('#analysisResult h3').innerText();
    await page.reload();await page.waitForFunction(()=>window.liveDoc?.project);await page.locator('#homeRecent button').filter({hasText:project}).click();await page.locator('#homeExperimental').click();
    await page.locator('#analysisViews').getByRole('button',{name:'Modules',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('#analysisHistory option').length>1);
    await page.locator('#analysisHistory').selectOption({index:1});await page.locator('#analysisResult svg').waitFor();
    if(errors.length)throw Error(errors.join('\n'));
    fs.mkdirSync('artifacts/verification',{recursive:true});
    fs.writeFileSync('artifacts/verification/plugins-electron.json',JSON.stringify({at:new Date().toISOString(),packaged:!!process.env.COSIGHT_TEST_APP,pythonMatch:'main.py:2',dependencySummary:summary,reloadRestored:true,pageErrors:errors,screenshot:'temp/plugins-electron.png'},null,2));
    console.log('PASS: real Electron Python search, module graph, and saved result replay after reload');
  }catch(e){if(page)console.error(await page.locator('body').innerText());throw e;}
  finally{await app.close();const identity=await fetch('http://127.0.0.1:18209/whoami').then(r=>r.json()).catch(()=>null);if(identity?.root===root)process.kill(identity.pid);}
})().catch(e=>{console.error(e);process.exitCode=1;});
