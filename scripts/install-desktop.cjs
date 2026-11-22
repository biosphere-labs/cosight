const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
if(process.platform!=='darwin')throw Error('This install helper currently supports macOS only.');
const root=path.resolve(__dirname,'..');
function run(command,args){const result=spawnSync(command,args,{cwd:root,stdio:'inherit'});if(result.error)throw result.error;if(result.status!==0)throw Error(`${command} exited ${result.status}`);}
run('npm',['run','pack']);
const outputFolder=process.arch==='x64'?'mac':'mac-'+process.arch;
const source=path.join(root,'dist',outputFolder,'CoSight.app');
const applications=path.join(os.homedir(),'Applications');
const target=path.join(applications,'CoSight.app');
const staging=path.join(applications,`.CoSight-install-${process.pid}.app`);
const backupRoot=path.join(os.homedir(),'Library/Application Support/CoSight/build-backups.noindex');
fs.mkdirSync(backupRoot,{recursive:true});
const backup=path.join(backupRoot,`CoSight-${Date.now()}.app-backup`);
const register='/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
fs.mkdirSync(applications,{recursive:true});
try{
  run('/usr/bin/ditto',[source,staging]);
  const hadPrevious=fs.existsSync(target);
  if(hadPrevious){spawnSync(register,['-u',target]);fs.renameSync(target,backup);}
  try{fs.renameSync(staging,target);}catch(error){if(hadPrevious)fs.renameSync(backup,target);throw error;}
  spawnSync(register,['-u',source]);
  const buildCopy=source+'.build';fs.rmSync(buildCopy,{recursive:true,force:true});fs.renameSync(source,buildCopy);
  run(register,['-f',target]);
  console.log(`Installed ${target}`);
  if(hadPrevious)console.log(`Previous app retained at ${backup}`);
}finally{fs.rmSync(staging,{recursive:true,force:true});}
