// Reproducible synthetic weekly sheets for the spreadsheet import acceptance: one tiny made-up Week 9, written as a real
// BIFF8 .xls, an .xlsx and a macro-enabled .xlsm by the pinned SheetJS release itself. The repository keeps no binary
// sheets, so nothing is committed: the writer is deterministic, and the SHA-256 recorded here for each workbook is
// checked every time one is built. Only the four tracked labels the parser requires are real; every other name, pick,
// tiebreak and kickoff below is invented.
//
//   node nfl-pool/acceptance/synthetic-workbooks.mjs <directory>   writes the three workbooks and prints their SHA-256
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadPinnedSheetJS,sha256Hex} from './sheetjs-pinned.mjs';

export const SYNTHETIC={
  season:2026,week:9,sheetName:'Week 9',
  rows:[
    ['Week 9 Synthetic QA Sheet'],
    ['1) Jaguars at 2) Ravens'],['3) Bengals at 4) Falcons'],['5) Packers at 6) Bears'],
    ['Entry','Pick1','Pick2','Pick3','Pts','W'],
    ['D.C.',1,3,5,41,0],['JC',2,3,6,42,0],['DJS',1,4,6,43,0],['Thaddius',2,4,5,44,0],
    ['QA Entrant Alpha',2,3,5,51,0],['QA Entrant Bravo',1,4,6,49,0]
  ],
  // What a correct read of any of the three workbooks must yield.
  games:[{awayNumber:1,away:'JAX',homeNumber:2,home:'BAL'},{awayNumber:3,away:'CIN',homeNumber:4,home:'ATL'},{awayNumber:5,away:'GB',homeNumber:6,home:'CHI'}],
  tracked:[
    {displayName:'D.C.',pickNumbers:[1,3,5],tiebreak:41},{displayName:'JC',pickNumbers:[2,3,6],tiebreak:42},
    {displayName:'DJS',pickNumbers:[1,4,6],tiebreak:43},{displayName:'Thaddeus',pickNumbers:[2,4,5],tiebreak:44}
  ],
  field:[{id:'field-001',pickNumbers:[2,3,5],tiebreak:51},{id:'field-002',pickNumbers:[1,4,6],tiebreak:49}],
  fieldNames:['QA Entrant Alpha','QA Entrant Bravo'],
  // The made-up week's schedule in the shape the Admin reads from the score feed.
  kickoff:'2026-11-08T18:00:00Z',kickoffDate:'2026-11-08'
};
SYNTHETIC.schedule={events:SYNTHETIC.games.map((g,i)=>({id:String(990001+i),date:SYNTHETIC.kickoff,
  competitions:[{competitors:[{homeAway:'away',team:{abbreviation:g.away}},{homeAway:'home',team:{abbreviation:g.home}}]}]}))};

export const WORKBOOKS=[
  {extension:'xls',bookType:'biff8',container:'cfb',sha256:'bc06d0a6e7421149437e9cc60733f2f356ad10e58927cadeaa9c4873715290a0'},
  {extension:'xlsx',bookType:'xlsx',container:'zip',sha256:'f3bead950ff67c331e748198720622980805705616360c1453f239b0edcf4565'},
  {extension:'xlsm',bookType:'xlsm',container:'zip',sha256:'ed01952db2f88e0145ce1e9b225cf2348dbc188308255eaf39014906f55c5bf5'}
];
const MAIN_PART={
  xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  xlsm:'application/vnd.ms-excel.sheet.macroEnabled.main+xml'
};

// One workbook of the given kind, compressed as Excel writes it so the reader's inflate path is exercised.
export function workbookBytes(XLSX,bookType,rows=SYNTHETIC.rows,sheetName=SYNTHETIC.sheetName){
  const book=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(rows),sheetName);
  return new Uint8Array(XLSX.write(book,{type:'array',bookType,compression:true}));
}

// The file is the kind its extension says: an OLE2 compound file holding a BIFF8 Workbook stream, or an Open Packaging
// ZIP whose workbook part declares the plain or the macro-enabled main content type.
function assertContainer(XLSX,{extension,container},bytes){
  const magic=Buffer.from(bytes.subarray(0,8)).toString('hex'),parts=XLSX.CFB.read(bytes,{type:'array'});
  const part=name=>{const found=XLSX.CFB.find(parts,name);assert(found,`${extension}: no ${name}`);return Buffer.from(found.content)};
  if(container==='cfb'){
    assert.equal(magic,'d0cf11e0a1b11ae1',`${extension}: not an OLE2 compound file`);
    const stream=part('Workbook');
    assert.equal(stream.readUInt16LE(0),0x0809,`${extension}: Workbook stream does not open with BOF`);
    assert.equal(stream.readUInt16LE(4),0x0600,`${extension}: not BIFF8`);
  }else{
    assert.equal(magic.slice(0,8),'504b0304',`${extension}: not a ZIP package`);
    const types=part('[Content_Types].xml').toString('utf8');
    assert(types.includes(`PartName="/xl/workbook.xml" ContentType="${MAIN_PART[extension]}"`),`${extension}: wrong workbook content type`);
    assert.equal(types.includes(MAIN_PART.xlsm),extension==='xlsm',`${extension}: macro-enabled marker`);
  }
}

// Writes the three workbooks into `directory` and returns them, each verified against its recorded SHA-256.
export function writeSyntheticWorkbooks(XLSX,directory){
  mkdirSync(directory,{recursive:true});
  return WORKBOOKS.map(kind=>{
    const bytes=workbookBytes(XLSX,kind.bookType),name=`synthetic-week-${SYNTHETIC.week}.${kind.extension}`,path=join(directory,name),sha256=sha256Hex(bytes);
    assertContainer(XLSX,kind,bytes);
    assert.equal(sha256,kind.sha256,`${name} is not the recorded workbook; the generator or the pinned writer changed`);
    writeFileSync(path,bytes);
    return{...kind,name,path,bytes,sha256};
  });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const directory=process.argv[2];
  if(!directory){console.error('usage: node nfl-pool/acceptance/synthetic-workbooks.mjs <directory>');process.exit(2)}
  const {XLSX}=await loadPinnedSheetJS();
  for(const w of writeSyntheticWorkbooks(XLSX,directory))console.log(`${w.sha256}  ${w.path}  (${w.bytes.length} bytes)`);
}
