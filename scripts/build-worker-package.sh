#!/usr/bin/env bash
# Run inside the isolated worker container. Build only; never launch Electron.
set -euo pipefail
SOURCE=${1:-/workspace}
OUTPUT=/tmp/cosight-native-package-staged
RECEIPTS="$SOURCE/artifacts/verification/worker-packaged"
mkdir -p "$RECEIPTS"
LOG="$RECEIPTS/build-staged.log"
MANIFEST="$RECEIPTS/staged-build.json"
VERIFY_STAGE=${2:-}
if [[ -z "$VERIFY_STAGE" && ( -e "$OUTPUT" || -L "$OUTPUT" ) ]]; then
  echo "Refusing existing staged output: $OUTPUT; preserve it for inspection." >&2
  exit 1
fi
if [[ -e "$MANIFEST" ]]; then
  echo 'Refusing to overwrite an existing staged-build manifest.' >&2
  exit 1
fi
exec > >(tee -a "$LOG") 2>&1
if [[ -n "$VERIFY_STAGE" ]]; then
  [[ "$VERIFY_STAGE" == /tmp/cosight-package-source.* && -d "$VERIFY_STAGE" && ! -L "$VERIFY_STAGE" ]] || { echo 'Invalid verification stage'; exit 1; }
  STAGE=$VERIFY_STAGE
else
  STAGE=$(mktemp -d /tmp/cosight-package-source.XXXXXX)
fi
export SOURCE OUTPUT STAGE MANIFEST
trap 'code=$?; if (( code != 0 )); then printf "Build failed (%s); source stage retained: %s\n" "$code" "$STAGE"; fi' EXIT
printf 'Isolated production source stage: %s\nOutput: %s\n' "$STAGE" "$OUTPUT"
if [[ -z "$VERIFY_STAGE" ]]; then
node --input-type=module <<'JS'
import fs from 'node:fs';import path from 'node:path';
const source=fs.realpathSync(process.env.SOURCE),stage=process.env.STAGE;
for(const entry of ['assets','electron']){
 function inspect(directory){for(const item of fs.readdirSync(directory,{withFileTypes:true})){const file=path.join(directory,item.name);if(item.isSymbolicLink())throw Error('Do not copy source symlinks into package staging: '+file);if(item.isDirectory())inspect(file);}}
 inspect(path.join(source,entry));fs.cpSync(path.join(source,entry),path.join(stage,entry),{recursive:true});
}
for(const file of ['package.json','package-lock.json'])fs.copyFileSync(path.join(source,file),path.join(stage,file));
const files=fs.readdirSync(stage).sort();if(JSON.stringify(files)!==JSON.stringify(['assets','electron','package-lock.json','package.json']))throw Error('Unexpected stage entries');
JS
ELECTRON_VERSION=$(node -p "require('/opt/cosight/node_modules/electron/package.json').version")
export ELECTRON_VERSION
printf 'Installed build Electron version: %s\n' "$ELECTRON_VERSION"
NPM_USER_CONFIG=$(mktemp /tmp/cosight-npm-user.XXXXXX)
NPM_GLOBAL_CONFIG=$(mktemp /tmp/cosight-npm-global.XXXXXX)
(
  cd "$STAGE"
  ELECTRON_SKIP_BINARY_DOWNLOAD=1 NPM_CONFIG_USERCONFIG="$NPM_USER_CONFIG" NPM_CONFIG_GLOBALCONFIG="$NPM_GLOBAL_CONFIG" npm ci --omit=dev --registry=https://registry.npmjs.org/
)
node --input-type=module <<'JS'
import fs from 'node:fs';import path from 'node:path';
const directory=path.join(process.env.STAGE,'node_modules');if(!fs.lstatSync(directory).isDirectory()||fs.lstatSync(directory).isSymbolicLink())throw Error('Stage node_modules must be a real directory');
for(const id of ['cordis','cosmokit','@modelcontextprotocol/sdk']){const pkg=JSON.parse(fs.readFileSync(path.join(directory,id,'package.json')));console.log('Production dependency:',id,pkg.version);}
const cordis=JSON.parse(fs.readFileSync(path.join(directory,'cordis/package.json')));if(!cordis.dependencies?.cosmokit)throw Error('Expected Cordis to declare cosmokit in its own production dependency closure');
JS
/opt/cosight/node_modules/.bin/electron-builder --projectDir "$STAGE" --dir --linux --publish never "-c.electronVersion=$ELECTRON_VERSION" "-c.directories.output=$OUTPUT"
else
  ELECTRON_VERSION=$(node -p "require('/opt/cosight/node_modules/electron/package.json').version")
  export ELECTRON_VERSION
  printf 'Verifying retained completed output without rebuilding: %s\n' "$OUTPUT"
fi
node --input-type=module <<'JS'
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),asar=require('/opt/cosight/node_modules/@electron/asar');
const {SOURCE:source,STAGE:stage,OUTPUT:output,MANIFEST:manifest,ELECTRON_VERSION:electronVersion}=process.env;
const executable=path.join(output,'linux-unpacked/cosight'),archive=path.join(output,'linux-unpacked/resources/app.asar');
for(const directory of [output,path.dirname(executable)]){const stat=fs.lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Build output must be a regular directory');}
for(const file of [executable,archive])if(!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink())throw Error('Expected regular packaged file: '+file);
const inventory=asar.listPackage(archive),hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const sourceChecks=[];function walk(relative){for(const item of fs.readdirSync(path.join(source,relative),{withFileTypes:true})){const file=path.join(relative,item.name);if(item.isDirectory())walk(file);else{const bytes=fs.readFileSync(path.join(source,file)),staged=fs.readFileSync(path.join(stage,file)),present=inventory.includes('/'+file),declarationExcluded=!present&&file.endsWith('.d.ts'),packaged=present?asar.extractFile(archive,file):null;sourceChecks.push({file,sha256:hash(bytes),matches:bytes.equals(staged)&&(declarationExcluded||!!packaged&&bytes.equals(packaged)),packaged:present,...(declarationExcluded?{packagingDisposition:'Electron Builder default TypeScript declaration exclusion'}:{})});}}}
walk('assets');walk('electron');
for(const file of ['package.json','package-lock.json']){const bytes=fs.readFileSync(path.join(source,file));sourceChecks.push({file,sha256:hash(bytes),matches:bytes.equals(fs.readFileSync(path.join(stage,file)))});}
const dependencyChecks=['cordis','cosmokit','@modelcontextprotocol/sdk'].map(id=>{const location='node_modules/'+id+'/package.json',production=JSON.parse(fs.readFileSync(path.join(stage,location))),packaged=JSON.parse(asar.extractFile(archive,location));return {module:id,productionPresent:true,version:production.version,packagedPresent:inventory.includes('/'+location),packagedVersion:packaged.version,matches:production.version===packaged.version};});
if(sourceChecks.some(check=>!check.matches)||dependencyChecks.some(check=>!check.packagedPresent||!check.matches))throw Error('Packaged source or dependency closure differs from checked stage');
const forbidden=inventory.filter(file=>/^\/(artifacts|temp|tests|\.git|\.codex|\.agents)(\/|$)/.test(file)||/(^|\/)\.npmrc$/.test(file));if(forbidden.length)throw Error('Private or build-only data in product archive: '+forbidden.join(','));
fs.writeFileSync(manifest,JSON.stringify({at:new Date().toISOString(),stage,output,executable,asar:archive,electronVersion,sourceChecks,dependencyChecks,stageEntries:fs.readdirSync(stage).sort(),archivePrivateEntries:forbidden,runtimeVerified:false},null,2));console.log('Validated staged package manifest:',manifest);
JS
