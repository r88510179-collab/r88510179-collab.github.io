// Acceptance findings F-02 and F-06 of 2026-11-23, as far as the stylesheet and the markup can show them without a
// browser. The browser checks that measure the pages are in tests/e2e/final-results.e2e.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const APP=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=name=>fs.readFileSync(path.join(APP,name),'utf8');
const css=read('styles.css');
const PAGES=['index.html','participant.html','commissioner.html'];
// The last rule written for exactly this selector list: later rules win at equal specificity.
const rule=selector=>{
  const found=[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([,selectors])=>selectors.replace(/\/\*[\s\S]*?\*\//g,'').trim()===selector);
  assert.ok(found.length,`styles.css has a rule for ${selector}`);
  return found.at(-1)[2].replace(/\s+/g,' ');
};

test('a selector keeps a long option inside its own box and is drawn without the native control',()=>{
  const select=rule('.field select,select');
  assert.match(select,/-webkit-appearance:none;appearance:none/,'WebKit draws a native selector 23px tall and ignores min-height');
  assert.match(select,/overflow:hidden/,'the option text may not spill into the field');
  assert.match(select,/text-overflow:ellipsis/);
  assert.match(select,/white-space:nowrap/);
  // The base rule still gives every selector its width and height.
  const base=rule('.field input,.field select,.field textarea,select');
  assert.match(base,/width:100%;min-height:48px/);
  assert.match(base,/font-size:16px/,'16px keeps iPhone Safari from zooming into a focused field');
});

test('the selector arrow is drawn in the stylesheet: the page policy allows images from this origin only',()=>{
  const select=rule('.field select,select');
  assert.match(select,/background-image:linear-gradient\(45deg,transparent 50%,var\(--muted\) 50%\), ?linear-gradient\(135deg,var\(--muted\) 50%,transparent 50%\)/);
  assert.match(select,/background-repeat:no-repeat/);
  assert.match(select,/padding-right:40px/,'room for the arrow, so an ellipsis never runs under it');
  assert.doesNotMatch(css,/url\(/,'no image, font or data: address anywhere in the stylesheet');
  assert.doesNotMatch(css,/@import/);
});

test('controls a person taps are at least 44px tall',()=>{
  assert.match(rule('a.brand'),/display:inline-flex;align-items:center;min-height:44px/);
  assert.match(rule('.advanced-import summary'),/min-height:44px/);
  assert.match(rule('#finalResultDetails>summary'),/min-height:44px/);
  assert.match(rule('.tap-target'),/min-height:44px/);
  assert.match(rule('.button'),/min-height:48px/);
  // .compact is 42px, so every compact button is also a .tap-target (44px, written after .compact).
  assert.match(css,/\.compact\{min-height:42px;[^}]*\}\.tap-target\{min-height:44px\}/);
  let compact=0;
  for(const page of PAGES){
    for(const [tag] of read(page).matchAll(/<(?:button|a)\b[^>]*class="[^"]*\bcompact\b[^"]*"[^>]*>/g)){
      compact++;
      assert.match(tag,/class="[^"]*\btap-target\b[^"]*"/,`${page}: ${tag}`);
    }
  }
  assert.equal(compact,6,'sign out, switch pool and refresh scores on each of the two signed-in pages');
});

test('every home link and section heading in the pages is covered by those rules',()=>{
  for(const page of ['participant.html','commissioner.html']){
    assert.match(read(page),/<a href="\.?\/" class="brand link-reset">POOL PLATFORM<\/a>/,page);
  }
  const html=read('commissioner.html');
  const details=[...html.matchAll(/<details\b[^>]*>/g)].map(([tag])=>tag);
  assert.equal(details.length,7);
  for(const tag of details)assert.match(tag,/class="advanced-import[^"]*"/,`${tag} has the heading rule`);
  assert.doesNotMatch(read('participant.html'),/<details\b/);
  // No control carries its own size in a style attribute (the page policy forbids those anyway).
  for(const page of PAGES)assert.doesNotMatch(read(page),/\sstyle="/,page);
});
