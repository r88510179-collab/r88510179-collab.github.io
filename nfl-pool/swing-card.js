// Shareable Swing Games card for the Personal Pool. Uses the same verified Pick'em snapshot
// and PNG/share-sheet controller as the existing standings cards; never fetches or scores games.
import {buildCard,shareLink,CARD_WIDTH,CARD_HEIGHT} from './share-card.js?v=2';

const reject=reason=>({ok:false,reason});
const integer=(v,min=0)=>Number.isSafeInteger(v)&&v>=min;
const text=(v,max)=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
const score=v=>v===null||integer(v)&&v<=300;
const fieldValid=(v,size)=>v===null||(
  v&&integer(v.pct)&&v.pct<=100&&integer(v.total,1)&&(size===null||v.total<=size)
);
const teamValid=v=>typeof v==='string'&&/^[A-Z]{2,4}$/.test(v);
const MAX_GAMES=20;

export function buildSwingCard(snapshot,options={}){
  if(!snapshot||typeof snapshot!=='object')return reject('Swing Games have not loaded. Reload the page and try again.');
  if(snapshot.ready!==true)return reject(text(snapshot.reason,200)?snapshot.reason:'Swing Games are not ready to share.');
  if(snapshot.contest!=='swings')return reject('The page returned a different section. Reload and try again.');
  // The existing validator checks publication identity, score freshness, rulings, records and full-field ranks.
  // A Swing Games card may never claim a stronger verification state than the matching standings card.
  const base=buildCard('pickem',{...snapshot,contest:'pickem'},options);
  if(!base.ok)return base;
  const games=snapshot.swingGames,size=snapshot.fieldSize;
  if(!Array.isArray(games)||games.length>MAX_GAMES||games.length>snapshot.games.remaining)
    return reject('The number of remaining Swing Games does not match this week.');
  const names=new Set(snapshot.entries.map(e=>e.name)),indices=new Set();
  for(const game of games){
    if(!game||!integer(game.index)||game.index>=snapshot.games.total||indices.has(game.index)||
      !text(game.status,100)||typeof game.live!=='boolean'||!score(game.awayScore)||!score(game.homeScore)||
      !text(game.tieImpact,500))return reject('The Swing Games data is incomplete or inconsistent.');
    indices.add(game.index);
    if(!game.live&&(game.awayScore!==null||game.homeScore!==null))
      return reject('The Swing Games score state is inconsistent.');
    const picked=new Set();
    for(const side of [game.away,game.home]){
      if(!side||!teamValid(side.team)||!text(side.impact,500)||!fieldValid(side.field,size)||
        !Array.isArray(side.pickers)||side.pickers.length>snapshot.entries.length)
        return reject('The Swing Games team data is incomplete.');
      for(const picker of side.pickers){
        if(!picker||!names.has(picker.name)||picked.has(picker.name)||typeof picker.out!=='boolean')
          return reject('The Swing Games picks are inconsistent.');
        picked.add(picker.name);
      }
    }
    if(game.away.team===game.home.team)return reject('A Swing Games matchup has the same team twice.');
  }
  const link=new URL(shareLink('pickem',snapshot,options.href));
  link.searchParams.set('view','games');
  const card={ok:true,contest:'swings',title:'Swing Games',season:base.season,week:base.week,
    revision:base.revision,status:base.status,snapshot:base.snapshot,capturedAt:base.capturedAt,
    games:games.map(g=>({...g,away:{...g.away,pickers:g.away.pickers.map(p=>({...p}))},
      home:{...g.home,pickers:g.home.pickers.map(p=>({...p}))}})),
    link:link.href,linkLabel:base.linkLabel,
    fileName:'nfl-pool-center-swing-games-'+base.season+'-week-'+base.week+'.png',
    height:Math.max(CARD_HEIGHT,350+games.length*255+185)};
  const count=games.length;
  const header='NFL Pool Center · '+card.season+' Week '+card.week+' Swing Games';
  const details=games.map((g,i)=>{
    const side=s=>s.team+': '+(s.pickers.map(p=>p.name+(p.out?' (OUT)':'')).join(', ')||'no tracked picks')+
      (s.field?' · '+s.field.pct+'% of '+s.field.total+' field entries':'')+' · '+s.impact;
    const scores=g.live?' '+(g.awayScore??'—')+'–'+(g.homeScore??'—'):'';
    return (i+1)+'. '+g.away.team+' vs '+g.home.team+' · '+g.status+scores+'\n'+side(g.away)+'\n'+side(g.home)+'\nTie: '+g.tieImpact;
  });
  card.summary=header+' · '+count+' remaining · '+card.status.label+'\n'+
    (count?details.join('\n\n'):'No Swing Games remain for this published week.')+
    '\nSnapshot '+card.snapshot+' · Revision '+card.revision+'\n'+card.link;
  card.shareTitle=header;
  card.shareText=header+' · '+count+' remaining · '+card.status.label+'\n'+card.link;
  card.alt=header+'. '+count+' remaining. '+(count?'Game matchups, tracked picks, field ownership and rooting impact shown.':'No swing games remain.');
  return card;
}

const WIDTH=CARD_WIDTH,ROW_STEP=255,ROW_HEIGHT=241;
function write(ctx,value,x,y,maxWidth,size=26,color='#fff',weight=700){
  ctx.fillStyle=color;ctx.font=weight+' '+size+'px Arial, sans-serif';
  ctx.textAlign='left';ctx.textBaseline='alphabetic';
  ctx.fillText(String(value),x,y,maxWidth);
}
const pickers=side=>side.pickers.length?side.pickers.map(p=>p.name+(p.out?' · OUT':'')).join('  /  '):'No tracked picks';
function drawSide(ctx,side,x,y){
  const width=440;
  write(ctx,side.team,x,y+79,width,43,'#fff',900);
  write(ctx,pickers(side),x,y+114,width,25,'#e2e8f0');
  write(ctx,side.field?side.field.pct+'% OF '+side.field.total+' FIELD ENTRIES':'FIELD OWNERSHIP UNAVAILABLE',x,y+147,width,20,side.field&&side.field.pct<=35?'#F7D279':'#a7b5c9',750);
  write(ctx,'IF '+side.team+': '+side.impact,x,y+179,width,23,'#d1d9e5',600);
}
export function drawSwingCard(ctx,card){
  const H=card.height||CARD_HEIGHT;
  ctx.save();
  ctx.fillStyle='#0D1117';ctx.fillRect(0,0,WIDTH,H);
  ctx.fillStyle='#1d2635';ctx.fillRect(0,0,WIDTH,14);
  ctx.fillStyle='#D4AF37';ctx.fillRect(52,50,6,145);
  write(ctx,'NFL POOL CENTER',84,90,900,27,'#d4af37',900);
  write(ctx,'SWING GAMES',84,155,900,65,'#fff',900);
  write(ctx,'SEASON '+card.season+'  •  WEEK '+card.week+'  •  '+card.games.length+' REMAINING',84,198,900,30,'#b8c4d6',750);
  ctx.fillStyle='#1b2634';ctx.fillRect(52,234,976,66);
  write(ctx,'STATUS: '+card.status.label,73,278,860,31,card.status.label==='FINAL'?'#d4af37':'#f4f6fa',900);
  const flags=card.status.flags||[];
  if(flags.length)write(ctx,flags.join(' · '),73,329,930,22,'#f7c56e',700);
  for(const [i,g] of card.games.entries()){
    const y=350+i*ROW_STEP;
    ctx.fillStyle='#1b222d';ctx.fillRect(52,y,976,ROW_HEIGHT);
    ctx.fillStyle='#D4AF37';ctx.fillRect(52,y,5,ROW_HEIGHT);
    ctx.fillStyle='#323e50';ctx.fillRect(546,y+60,2,134);
    write(ctx,'GAME '+(i+1)+'  ·  '+g.away.team+' @ '+g.home.team,75,y+36,690,29,'#d4af37',900);
    const match=g.live?(g.awayScore??'—')+'–'+(g.homeScore??'—')+' · '+g.status:g.status;
    write(ctx,match,783,y+36,210,25,'#c9d4e5',800);
    drawSide(ctx,g.away,75,y);
    drawSide(ctx,g.home,566,y);
    write(ctx,'TIE: '+g.tieImpact,75,y+221,925,21,'#aab8c9',650);
  }
  if(!card.games.length){
    write(ctx,'NO SWING GAMES REMAIN',75,450,935,45,'#d4af37',850);
    write(ctx,'The race now depends on finalized results and the tiebreak.',75,502,930,27,'#bec8d8',600);
  }
  const footerY=H-131;
  ctx.fillStyle='#D4AF37';ctx.fillRect(52,footerY-26,976,2);
  write(ctx,'SNAPSHOT '+card.snapshot.toUpperCase()+'  ·  REVISION '+card.revision,62,footerY+18,952,23,'#d8e1ec',700);
  write(ctx,card.linkLabel+'  ·  Full week available at the Games tab',62,footerY+63,952,22,'#8b9bad',650);
  ctx.restore();
  return {width:WIDTH,height:H,rows:card.games.length};
}
