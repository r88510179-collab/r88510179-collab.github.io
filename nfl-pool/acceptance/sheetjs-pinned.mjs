// The one spreadsheet-reader release the Personal Pool admin pages may load, and how the browser acceptance obtains it.
//
// Provenance, recorded 2026-11-25: SheetJS Community Edition 0.20.3 (Apache-2.0) from the publisher's own distribution,
// cdn.sheetjs.com. The module the pages import is byte-identical to xlsx.mjs inside the publisher's package tarball,
// which is what the browser acceptance workflow installs. The npm registry's "xlsx" package ends at the unpatched
// 0.18.5 and is not this library's source any more: never install the reader from the registry.
//
// Weekly Admin and Organizer Corrections each carry an import map that pins SHEETJS_INTEGRITY for SHEETJS_URL, so a
// browser that enforces import-map integrity refuses any other bytes at that address. To move to another release,
// change the URL in both admin scripts and both import maps, and re-record the four values below from the new file.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export const SHEETJS_VERSION='0.20.3';
export const SHEETJS_URL='https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';
export const SHEETJS_PACKAGE='https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz';
export const SHEETJS_BYTES=1008308;
export const SHEETJS_SHA256='1a0fb062ee9781b13f6687371b202aaefc53b6ce55b530c027e01f9c087b77db';
export const SHEETJS_INTEGRITY='sha384-Z4EKe5a5DXkOl0inZS9gbLhWC3oWGsUGEe39GJ62+77NMKyfNjPWtP1Ilgb1Jzzy';

export const sha256Hex=bytes=>createHash('sha256').update(bytes).digest('hex');

// The installed reader, accepted only when it is the recorded release byte for byte. A test that runs against any other
// copy proves nothing about the pages, so a mismatch stops the run instead of being skipped.
export async function loadPinnedSheetJS(){
  let location;
  try{location=import.meta.resolve('xlsx')}
  catch{throw new Error(`The pinned spreadsheet reader is not installed. Run: npm install --no-save --no-package-lock ${SHEETJS_PACKAGE}`)}
  const path=fileURLToPath(location),bytes=readFileSync(path);
  const wrong=`${path} is not SheetJS ${SHEETJS_VERSION} from ${SHEETJS_PACKAGE}`;
  assert.equal(bytes.length,SHEETJS_BYTES,wrong);
  assert.equal(sha256Hex(bytes),SHEETJS_SHA256,wrong);
  assert.equal('sha384-'+createHash('sha384').update(bytes).digest('base64'),SHEETJS_INTEGRITY,wrong);
  const XLSX=await import(location);
  assert.equal(XLSX.version,SHEETJS_VERSION,wrong);
  return{XLSX,bytes,path};
}

// Answers the pinned address from the verified local copy and refuses every other request for a spreadsheet reader, so
// a page under test can neither reach a CDN nor quietly run a different release. `body` defaults to the genuine bytes;
// a test passes altered bytes to prove the page refuses them. The returned record counts what the page asked for.
export async function servePinnedSheetJS(target,bytes,{body=bytes}={}){
  const seen={pinned:0,refused:[]};
  await target.route(/sheetjs|xlsx/i,route=>{
    const url=route.request().url();
    if(new URL(url).hostname==='127.0.0.1')return route.fallback();
    if(url!==SHEETJS_URL){seen.refused.push(url);return route.abort()}
    seen.pinned++;
    return route.fulfill({status:200,contentType:'text/javascript',headers:{'access-control-allow-origin':'*'},body:Buffer.from(body)});
  });
  return seen;
}
