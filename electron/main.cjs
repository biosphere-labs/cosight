const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { fork } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const root = path.resolve(process.env.COSIGHT_DATA_DIR || path.join(os.homedir(), '.local/share/cosight'));
const port = Number(process.env.COSIGHT_PORT || 8099);
let child, win;
if(process.env.COSIGHT_USER_DATA_DIR) app.setPath('userData',path.resolve(process.env.COSIGHT_USER_DATA_DIR));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if(win){ win.show(); win.focus(); } });
  ipcMain.handle('provider-login', async (_event, provider) => {
    const commands={codex:['codex','login'],claude:['claude','auth','login'],antigravity:['agy']};
    if(!commands[provider])throw Error('Choose a supported CLI provider.');
    const {binary}=await import('../assets/agent-config.js');
    const args=commands[provider].slice();args[0]=binary(args[0]);
    const quote=value=>"'"+value.replace(/'/g,"'\\''")+"'";
    const command=args.map(quote).join(' ');
    const {execFile}=require('node:child_process');
    await new Promise((resolve,reject)=>execFile('/usr/bin/osascript',['-e','tell application "Terminal"','-e','activate','-e','do script '+JSON.stringify(command),'-e','end tell'],error=>error?reject(error):resolve()));
    return {opened:true};
  });
  ipcMain.handle('choose-document', async () => { const result=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:'Markdown documents',extensions:['md','markdown']}]});return result.canceled?null:result.filePaths[0]; });
  ipcMain.handle('choose-project', async () => { const result=await dialog.showOpenDialog(win,{properties:['openDirectory']});return result.canceled?null:result.filePaths[0]; });
  ipcMain.handle('open-external',async(_event,value)=>{const target=new URL(value);if(!['https://mcp.linear.app','https://linear.app'].includes(target.origin)||target.username||target.password)throw Error('Unsupported external link');await shell.openExternal(target.href);return {opened:true};});
  app.whenReady().then(open).catch(e => { dialog.showErrorBox('CoSight could not start', e.message); app.quit(); });
  app.on('activate', () => { if(win) win.show(); });
  app.on('window-all-closed', () => app.quit());
}
async function open() {
  const url = `http://127.0.0.1:${port}/`;
  let existing;
  try { existing = await (await fetch(url+'whoami', { signal: AbortSignal.timeout(1500) })).json(); } catch {}
  if(existing && path.resolve(existing.root || '') !== root) {
    throw Error('Another data directory is using this port. Choose another COSIGHT_PORT.');
  }
  if(existing && existing.api < 18){
    if(!Number.isInteger(existing.pid) || existing.pid<=0 || !Number.isInteger(existing.api)) throw Error('Unrecognized server on the CoSight port.');
    // Same identity/root check as start-canvas.sh: upgrade the tour server, preserving its files.
    process.kill(existing.pid, 'SIGTERM');
    for(let i=0;i<50;i++){
      try{await fetch(url+'whoami',{signal:AbortSignal.timeout(200)});}
      catch{existing=null; break;}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(existing) throw Error('The previous tour server did not stop.');
  }
  if(!existing){
    fs.mkdirSync(root, {recursive:true});
    await new Promise((resolve,reject) => {
      child = fork(path.join(__dirname,'../assets/tour-server.js'), [root,String(port),'127.0.0.1'], {
        execPath: process.execPath, env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}, detached:true,
        stdio:['ignore','ignore','ignore','ipc'],
      });
      const timer=setTimeout(() => { child.kill(); reject(Error('Tour server did not start within 15 seconds')); },15000);
      child.once('message', () => { clearTimeout(timer); child.disconnect(); child.unref(); resolve(); });
      child.once('error', e => {clearTimeout(timer); reject(e);});
      child.once('exit', code => {clearTimeout(timer); reject(Error(`Tour server exited (${code})`));});
    });
  }
  win = new BrowserWindow({ width:1440,height:940,minWidth:900,minHeight:600,backgroundColor:'#101218',title:'CoSight',
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,autoplayPolicy:'no-user-gesture-required'} });
  win.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  win.webContents.on('will-navigate', (event,target) => { if(new URL(target).origin!==new URL(url).origin) event.preventDefault(); });
  win.webContents.session.setPermissionRequestHandler((contents,permission,callback,details) => {
    const local=contents===win.webContents && new URL(contents.getURL()).origin===new URL(url).origin;
    callback(local && permission==='media' && details.mediaTypes?.length>0 && details.mediaTypes.every(type=>type==='audio'));
  });
  win.webContents.session.setPermissionCheckHandler((contents,permission,origin,details) => contents===win.webContents && origin===new URL(url).origin && permission==='media' && details.mediaType==='audio');
  win.on('closed', () => {win=null;});
  await win.loadURL(url);
}
