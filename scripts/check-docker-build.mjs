// The standalone image runs scripts/build-board.mjs in its build stage. Every file that
// script reads or imports must be in the Docker build context (.dockerignore) and copied
// into that stage (Dockerfile) before the build step. No Docker is needed: this check
// traces the build's reads, applies Docker's context and COPY rules, and then replays the
// build stage in a temporary directory.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,mkdirSync,copyFileSync,readdirSync,statSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import os from 'node:os';
import path from 'node:path';

const BUILD_SCRIPT='scripts/build-board.mjs';
const posix=path.posix;

// .dockerignore: Docker's documented rules. A path is excluded when it or a parent
// directory matches; later lines win; "!" re-includes.
export function contextRules(text) {
  return text.split(/\r?\n/).map(line=>line.trim()).filter(line=>line && !line.startsWith('#')).map(line=>{
    const negate=line.startsWith('!'), raw=posix.normalize((negate?line.slice(1):line).trim().replace(/^\/+/,'')).replace(/\/$/,'');
    const source=raw.split(/(\*\*\/?|\*|\?)/).map(part=>part==='**/'?'(?:.*/)?':part==='**'?'.*':part==='*'?'[^/]*':part==='?'?'[^/]':part.replace(/[.+^${}()|[\]\\]/g,'\\$&')).join('');
    return {negate,pattern:new RegExp('^'+source+'$'),line};
  });
}
export function inContext(rules,file) {
  const candidates=file.split('/').map((_,index,parts)=>parts.slice(0,index+1).join('/'));
  let excluded=false;
  for(const rule of rules)if(candidates.some(candidate=>rule.pattern.test(candidate)))excluded=!rule.negate;
  return !excluded;
}

// Dockerfile: the build stage's WORKDIR and local COPY instructions before the build step.
export function buildStage(text) {
  if(/^\s*#\s*escape\s*=/im.test(text))throw new Error('Unsupported Dockerfile escape directive');
  const lines=text.replace(/\\\r?\n[ \t]*/g,' ').split(/\r?\n/).map(line=>line.trim()).filter(line=>line && !line.startsWith('#'));
  const start=lines.findIndex(line=>/^FROM\s/i.test(line));
  const end=lines.findIndex((line,index)=>index>start && /^FROM\s/i.test(line));
  const stage=lines.slice(start,end<0?undefined:end);
  let workdir='/', copies=[], build=null;
  for(const line of stage) {
    const [instruction,...rest]=line.split(/\s+/), argument=rest.join(' ');
    if(/^WORKDIR$/i.test(instruction))workdir=posix.resolve(workdir,argument);
    else if(/^ADD$/i.test(instruction))throw new Error('The build stage uses ADD; extend this check before relying on it');
    else if(/^COPY$/i.test(instruction)) {
      let words=rest;
      if(words.some(word=>/^--from=/.test(word)))continue;
      while(words[0]?.startsWith('--')) {
        if(!/^--(?:chown|chmod)=[A-Za-z0-9_:,+-]+$|^--link$/.test(words[0]))throw new Error('Unsupported COPY option '+words[0]);
        words=words.slice(1);
      }
      if(words[0]?.startsWith('['))throw new Error('JSON COPY syntax is not supported by this check');
      if(words.length<2 || words.some(word=>/[*?[\]$\\'"]/.test(word)))throw new Error('Unsupported COPY sources: '+line);
      if(!build)copies.push({sources:words.slice(0,-1).map(source=>posix.normalize(source).replace(/\/$/,'')),dest:words.at(-1),workdir});
    }
    else if(/^RUN$/i.test(instruction) && argument.includes(BUILD_SCRIPT))build={workdir,argument};
  }
  if(!build)throw new Error('The build stage never runs '+BUILD_SCRIPT);
  if(!build.argument.includes('--standalone'))throw new Error('The build stage must run '+BUILD_SCRIPT+' --standalone');
  return {copies,build};
}
// Where a context file lands in the image, for every COPY that includes it.
function targets(copy,file,isDirectory) {
  const dest=posix.resolve(copy.workdir,copy.dest), many=copy.sources.length>1 || copy.dest.endsWith('/');
  return copy.sources.flatMap(source=>{
    if(source==='.')return [posix.join(dest,file)];
    if(file===source)return [isDirectory(source)?dest:many?posix.join(dest,posix.basename(source)):dest];
    if(file.startsWith(source+'/'))return [posix.join(dest,file.slice(source.length+1))];
    return [];
  });
}
// Problems for each file the build needs: outside the context, or never copied to where it is read.
export function coverageProblems(dockerignore,dockerfile,needed,isDirectory=()=>false) {
  const rules=contextRules(dockerignore), {copies,build}=buildStage(dockerfile), problems=[];
  for(const file of needed) {
    if(!inContext(rules,file)){problems.push(file+' is excluded from the build context by .dockerignore');continue;}
    const wanted=posix.join(build.workdir,file);
    if(!copies.some(copy=>targets(copy,file,isDirectory).includes(wanted)))problems.push(file+' is not copied to '+wanted+' before '+BUILD_SCRIPT+' runs');
  }
  return problems;
}

// Files the build reads (traced, with writes discarded) plus its local imports (parsed).
export function tracedReads(root) {
  const tempDir=mkdtempSync(path.join(os.tmpdir(),'crowsnest-docker-trace-'));
  try {
    const log=path.join(tempDir,'reads.json'), tracer=path.join(tempDir,'trace.mjs');
    writeFileSync(tracer,`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {fileURLToPath} from 'node:url';
const reads=new Set(), name=value=>value instanceof URL?fileURLToPath(value):String(value);
const syncRead=fs.readFileSync, asyncRead=fs.promises.readFile, syncWrite=fs.writeFileSync;
fs.readFileSync=function(file,...rest){if(typeof file!=='number')reads.add(name(file));return syncRead.call(this,file,...rest);};
fs.promises.readFile=function(file,...rest){if(typeof file!=='number' && typeof file?.fd!=='number')reads.add(name(file));return asyncRead.call(this,file,...rest);};
fs.promises.writeFile=async()=>{};fs.promises.mkdir=async()=>{};fs.writeFileSync=()=>{};fs.mkdirSync=()=>{};
syncBuiltinESMExports();
process.on('exit',()=>syncWrite.call(fs,${JSON.stringify(log)},JSON.stringify([...reads])));
`);
    writeFileSync(log,'[]');
    const run=spawnSync(process.execPath,['--import',pathToFileURL(tracer).href,BUILD_SCRIPT,'--standalone'],{cwd:root,encoding:'utf8'});
    if(run.status!==0)throw new Error('Traced build failed: '+(run.stderr||run.stdout).trim().split('\n').slice(0,4).join(' | '));
    const reads=JSON.parse(readFileSync(log,'utf8')).map(file=>path.relative(root,path.resolve(root,file))).filter(file=>!file.startsWith('..') && !path.isAbsolute(file));
    const imports=new Set([BUILD_SCRIPT]), queue=[BUILD_SCRIPT];
    while(queue.length) {
      const file=queue.shift(), source=readFileSync(path.join(root,file),'utf8');
      if(/\bimport\s*\(/.test(source))throw new Error(file+' uses a dynamic import; extend this check');
      for(const [,specifier] of source.matchAll(/\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const next=posix.normalize(posix.join(posix.dirname(file),specifier));
        if(!imports.has(next)){imports.add(next);queue.push(next);}
      }
    }
    return [...new Set([...imports,...reads])].sort();
  } finally {rmSync(tempDir,{recursive:true,force:true});}
}

// Replays the build stage: context filter, COPY into WORKDIR, then the real build command.
function replay(root,dockerignore,dockerfile) {
  const rules=contextRules(dockerignore), {copies,build}=buildStage(dockerfile);
  const tempDir=mkdtempSync(path.join(os.tmpdir(),'crowsnest-docker-stage-'));
  const place=target=>path.join(tempDir,target);
  const copyTree=(source,target)=>{
    const from=path.join(root,source);
    if(statSync(from).isDirectory()){for(const entry of readdirSync(from)){const child=posix.join(source,entry);if(inContext(rules,child))copyTree(child,posix.join(target,entry));}}
    else {mkdirSync(path.dirname(place(target)),{recursive:true});copyFileSync(from,place(target));}
  };
  try {
    for(const copy of copies) {
      const dest=posix.resolve(copy.workdir,copy.dest), many=copy.sources.length>1 || copy.dest.endsWith('/');
      for(const source of copy.sources) {
        if(!existsSync(path.join(root,source)) || !inContext(rules,source))throw new Error('COPY '+source+' is not in the build context');
        copyTree(source,statSync(path.join(root,source)).isDirectory()?dest:many?posix.join(dest,posix.basename(source)):dest);
      }
    }
    const cwd=place(build.workdir);mkdirSync(cwd,{recursive:true});
    const run=spawnSync(process.execPath,[BUILD_SCRIPT,'--standalone'],{cwd,encoding:'utf8'});
    if(run.status!==0)throw new Error('Replayed build stage failed: '+(run.stderr||run.stdout).trim().split('\n').slice(0,4).join(' | '));
    if(!existsSync(path.join(cwd,'dist/server/index.js')))throw new Error('Replayed build stage produced no dist/server/index.js');
  } finally {rmSync(tempDir,{recursive:true,force:true});}
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  // Rule fixtures: Docker's parent-directory matching, last match wins, and re-inclusion.
  const rules=contextRules('*\n!scripts/\n!scripts/build-board.mjs\n!worker/\n!worker/**\n**/node_modules\n**/.env\n');
  assert.equal(inContext(rules,'worker/storage.js'),true);
  assert.equal(inContext(rules,'scripts/build-board.mjs'),true);
  // "!scripts/" re-includes every file under it (its parent matches), as Docker does.
  assert.equal(inContext(rules,'scripts/check-storage.mjs'),true);
  assert.equal(inContext(rules,'README.md'),false);
  assert.equal(inContext(rules,'worker/node_modules/x/index.js'),false);
  assert.equal(inContext(rules,'storage-agent/version.json'),false);
  const root=process.cwd(), dockerignore=readFileSync('.dockerignore','utf8'), dockerfile=readFileSync('Dockerfile','utf8');
  const isDirectory=file=>{try{return statSync(path.join(root,file)).isDirectory();}catch{return false;}};
  const needed=tracedReads(root);
  for(const file of ['scripts/collector-metadata.mjs','package.json','worker/board.js','storage-agent/version.json','storage-agent/crowsnest_storage.py','storage-agent/crowsnest-storage.service','storage-agent/setup.sh'])
    assert.ok(needed.includes(file),'the traced build reads '+file);
  const problems=coverageProblems(dockerignore,dockerfile,needed,isDirectory);
  assert.deepEqual(problems,[],'Docker build stage is missing inputs of '+BUILD_SCRIPT+':\n  '+problems.join('\n  '));
  // Each missing piece is reported on its own.
  const withoutContext=dockerignore.replace(/^!storage-agent\/\*?\*?\n/gm,'');
  assert.ok(coverageProblems(withoutContext,dockerfile,needed,isDirectory).includes('storage-agent/version.json is excluded from the build context by .dockerignore'));
  const withoutCopy=dockerfile.replace(/^COPY storage-agent storage-agent\n/m,'');
  assert.ok(coverageProblems(dockerignore,withoutCopy,needed,isDirectory).includes('storage-agent/version.json is not copied to /app/storage-agent/version.json before '+BUILD_SCRIPT+' runs'));
  replay(root,dockerignore,dockerfile);
  console.log('Docker build checks passed: '+needed.length+' files read by '+BUILD_SCRIPT+' are in the build context and copied into the build stage; the replayed stage builds.');
}
