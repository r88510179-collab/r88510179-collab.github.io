// Builds the commercial frontend into dist/ (or --out <dir>) from three sources only:
//   1. STATIC_FILES, an explicit allow-list of files in pool-platform/, copied byte for byte;
//   2. platform-config.js, generated from POOL_PLATFORM_* (a sandbox unless POOL_PLATFORM_MODE=live);
//   3. vendor/neon-js.js, the pinned @neondatabase/neon-js bundled from package-lock.json, so the browser loads the
//      SDK from its own origin and never from a CDN.
// Nothing else under pool-platform/ (tests, docs, migrations, validation, scripts, node_modules, the tracked
// platform-config.js) and nothing outside it can reach the output. A sandbox and a live build differ only in
// platform-config.js, and the same inputs always produce the same bytes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {contentSecurityPolicy,runtimeConfigFromEnv,serializeRuntimeConfig} from './runtime-config.mjs';

export const APP_DIR=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
export const STATIC_FILES=Object.freeze([
  'index.html','participant.html','commissioner.html','styles.css','manifest.webmanifest',
  'service-worker.js','sw-register.js','participant.js','commissioner.js','platform-client.js',
  'auth-core.js','submission-core.js','participant-core.js','import-core.js'
]);
export const CONFIG_FILE='platform-config.js';
export const SDK_FILE='vendor/neon-js.js';
export const OUTPUT_FILES=Object.freeze([...STATIC_FILES,CONFIG_FILE,SDK_FILE].sort());
export const NEON_SDK=Object.freeze({name:'@neondatabase/neon-js',version:'0.7.0-beta'});

// Allow-list entries are plain names of files beside this directory's pages: no path, so none can reach elsewhere.
for(const name of STATIC_FILES){
  if(!/^[a-z][a-z0-9-]*\.(?:html|css|js|webmanifest)$/.test(name))throw new Error(`allow-list entry ${name} is not a plain file name`);
}

const sha256=body=>crypto.createHash('sha256').update(body).digest('hex');
const isInside=(child,parent)=>{const rel=path.relative(parent,child);return rel===''||(!rel.startsWith('..')&&!path.isAbsolute(rel))};

function readAllowedFile(appDir,name){
  const file=path.join(appDir,name),stat=fs.lstatSync(file,{throwIfNoEntry:false});
  if(!stat?.isFile())throw new Error(`${name} must be a regular file in ${appDir} (it is missing, a directory or a symbolic link)`);
  return fs.readFileSync(file);
}

// Relative paths (with /) of everything under dir. A symbolic link or special file is listed as "<path> (not a
// regular file)", so it can never match an expected output name.
export function listFiles(dir){
  const found=[];
  const walk=rel=>{
    for(const entry of fs.readdirSync(path.join(dir,rel),{withFileTypes:true})){
      const child=rel?`${rel}/${entry.name}`:entry.name;
      if(entry.isDirectory())walk(child);
      else found.push(entry.isFile()?child:`${child} (not a regular file)`);
    }
  };
  walk('');
  return found.sort();
}

// npm ci installs exactly package-lock.json; anything else (npm install drift, a hand-edited node_modules) stops
// the build, so the bundle is always made from the locked tree. Only another platform's optional binary may be absent.
export function assertInstalledMatchesLockfile(appDir=APP_DIR){
  const lock=JSON.parse(fs.readFileSync(path.join(appDir,'package-lock.json'),'utf8'));
  for(const [key,entry] of Object.entries(lock.packages)){
    if(!key)continue;
    let installed;
    try{installed=JSON.parse(fs.readFileSync(path.join(appDir,key,'package.json'),'utf8')).version}catch{installed=undefined}
    if(installed===undefined&&entry.optional)continue;
    if(installed!==entry.version){
      throw new Error(`${key} is ${installed===undefined?'not installed':`installed at ${installed}`}, but package-lock.json pins ${entry.version}: run npm ci in pool-platform`);
    }
  }
}

// What the bundle must be: one self-contained module (no import of anything, from anywhere), no CDN reference,
// the SDK's own name/version record reading exactly the pinned version, and createClient exported.
export function verifySdkBundle(code){
  if(/^\s*import\s*[\w{*'"]/m.test(code)||/\bimport\s*\(/.test(code))throw new Error('the Neon SDK bundle is not self-contained: it still imports a module');
  if(/cdn\.jsdelivr\.net|unpkg\.com|esm\.sh|skypack\.dev|jspm\.io/i.test(code))throw new Error('the Neon SDK bundle names a CDN');
  const record=new RegExp(`\\nvar (name\\d*) = "${NEON_SDK.name.replace('/','\\/')}";\\nvar (version\\d*) = "${NEON_SDK.version.replace(/\./g,'\\.')}";\\nfunction buildNeonJsClientInfo\\(\\) \\{\\n  const info = getClientInfo\\d* ?\\(\\1, \\2\\);`);
  if(!record.test(code))throw new Error(`the Neon SDK bundle does not carry ${NEON_SDK.name} ${NEON_SDK.version}'s own version record`);
  if(!/\nexport \{[^}]*\bcreateClient\b[^}]*\};\s*$/.test(code))throw new Error('the Neon SDK bundle does not export createClient');
  return code;
}

// The exact package, as the lockfile resolves it, in one ESM file. Nothing is minified or renamed beyond what
// bundling needs, so the vendored code reads as the package's own. Modules the SDK's packages declare side-effect
// free and that nothing uses (the React adapter chain behind a bare import) are left out, as package.json allows.
export async function bundleNeonSdk(appDir=APP_DIR){
  assertInstalledMatchesLockfile(appDir);
  const installed=JSON.parse(fs.readFileSync(path.join(appDir,'node_modules',NEON_SDK.name,'package.json'),'utf8')).version;
  if(installed!==NEON_SDK.version)throw new Error(`${NEON_SDK.name} ${installed} is installed; ${NEON_SDK.version} is required`);
  let esbuild;
  try{esbuild=await import('esbuild')}catch{throw new Error('esbuild is not installed: run npm ci in pool-platform')}
  const result=await esbuild.build({
    absWorkingDir:appDir,
    stdin:{contents:`export * from '${NEON_SDK.name}';\n`,resolveDir:appDir,sourcefile:'neon-js-entry.js',loader:'js'},
    bundle:true,format:'esm',platform:'browser',charset:'utf8',legalComments:'inline',
    // What a production bundle sees, as in the CDN build this replaces. Every other process access in the SDK is
    // behind a typeof process check, so it stays inert in a browser.
    define:{'process.env.NODE_ENV':'"production"'},
    banner:{js:`// ${NEON_SDK.name} ${NEON_SDK.version}, the exact package from package-lock.json, bundled by scripts/build.mjs with esbuild ${esbuild.version}. Do not edit.`},
    write:false,logLevel:'silent'
  });
  if(result.warnings.length)throw new Error(`bundling the Neon SDK produced warnings: ${result.warnings.map(w=>w.text).join('; ')}`);
  return verifySdkBundle(result.outputFiles[0].text);
}

// Replaces outDir only when that is plainly safe: never a directory holding the sources, never another directory
// inside pool-platform/ than dist/, and only a directory holding nothing but files this build produces.
function replaceOutputDirectory(outDir,files,appDir){
  if(isInside(appDir,outDir))throw new Error(`refusing to build into ${outDir}: it contains the application sources`);
  if(isInside(outDir,appDir)&&outDir!==path.join(appDir,'dist'))throw new Error(`refusing to build into ${outDir}: inside ${appDir} only dist/ may be written`);
  const stat=fs.lstatSync(outDir,{throwIfNoEntry:false});
  if(stat){
    if(!stat.isDirectory())throw new Error(`refusing to replace ${outDir}: it is not a directory`);
    const unexpected=listFiles(outDir).filter(file=>!OUTPUT_FILES.includes(file));
    if(unexpected.length)throw new Error(`refusing to replace ${outDir}: it holds ${unexpected[0]}, which this build does not produce`);
    fs.rmSync(outDir,{recursive:true});
  }
  for(const [name,body] of files){
    const file=path.join(outDir,...name.split('/'));
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,body);
  }
}

export async function buildCommercialFrontend({appDir=APP_DIR,outDir,env=process.env,bundleSdk=bundleNeonSdk}={}){
  appDir=path.resolve(appDir);
  outDir=path.resolve(outDir??path.join(appDir,'dist'));
  // Everything is read and checked before anything is written: a bad configuration leaves no output behind.
  const config=runtimeConfigFromEnv(env);
  const files=new Map(STATIC_FILES.map(name=>[name,readAllowedFile(appDir,name)]));
  files.set(CONFIG_FILE,Buffer.from(serializeRuntimeConfig(config)));
  files.set(SDK_FILE,Buffer.from(await bundleSdk(appDir)));
  replaceOutputDirectory(outDir,files,appDir);
  const written=listFiles(outDir);
  if(written.join('\n')!==OUTPUT_FILES.join('\n'))throw new Error(`build output differs from the allow-list: ${written.join(', ')}`);
  return{
    config,outDir,csp:contentSecurityPolicy(config),
    files:OUTPUT_FILES.map(name=>({name,bytes:files.get(name).length,sha256:sha256(files.get(name))}))
  };
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const args=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i++){
    if(args[i]==='--out'&&args[i+1])options.outDir=args[++i];
    else{console.error(`Unknown argument: ${args[i]} (usage: node scripts/build.mjs [--out <dir>])`);process.exit(2)}
  }
  try{
    const {config,outDir,csp,files}=await buildCommercialFrontend(options);
    console.log(`Built the ${config.mode} commercial frontend in ${outDir}`);
    if(config.mode==='live')console.log(`  Auth URL: ${config.authUrl}\n  Data API URL: ${config.dataUrl}`);
    console.log(`  Default pool slug: ${config.defaultPoolSlug||'(none)'}`);
    for(const file of files)console.log(`  ${file.sha256}  ${String(file.bytes).padStart(7)}  ${file.name}`);
    console.log(`Content-Security-Policy for this build: ${csp}`);
  }catch(error){
    console.error(`Build failed: ${error.message}`);
    process.exitCode=1;
  }
}
