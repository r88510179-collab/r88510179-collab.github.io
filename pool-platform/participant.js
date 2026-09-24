import {validatePickPayload} from './submission-core.js';

const games=[
  {id:'g1',away:'Austin',home:'Denver'},
  {id:'g2',away:'Phoenix',home:'Seattle'},
  {id:'g3',away:'Nashville',home:'Baltimore'},
  {id:'g4',away:'Charlotte',home:'Chicago'},
  {id:'g5',away:'Las Vegas',home:'Miami'},
  {id:'g6',away:'New York',home:'Los Angeles'}
];

const form=document.getElementById('pickForm');
const gamesEl=document.getElementById('games');
const tiebreak=document.getElementById('tiebreak');
const validation=document.getElementById('validation');
const summary=document.getElementById('summary');
const submittedCard=document.getElementById('submittedCard');
const submitBtn=document.getElementById('submitBtn');
const clearBtn=document.getElementById('clearBtn');

function renderGames(){
  gamesEl.innerHTML=games.map((g,i)=>`
    <fieldset class="game">
      <legend>Game ${i+1}</legend>
      <div class="choices">
        <div class="pick-option">
          <input type="radio" id="${g.id}-away" name="${g.id}" value="away">
          <label for="${g.id}-away">${g.away}</label>
        </div>
        <div class="pick-option">
          <input type="radio" id="${g.id}-home" name="${g.id}" value="home">
          <label for="${g.id}-home">${g.home}</label>
        </div>
      </div>
    </fieldset>`).join('');
}

function currentPayload(){
  const picks={};
  for(const game of games){
    const selected=form.querySelector(`input[name="${game.id}"]:checked`);
    if(selected)picks[game.id]=selected.value;
  }
  return{picks,tiebreak:tiebreak.value};
}

function renderSummary(){
  const payload=currentPayload();
  summary.innerHTML=games.map(game=>{
    const side=payload.picks[game.id];
    const value=side?game[side]:'—';
    return`<div class="summary-row"><span>${game.away} vs ${game.home}</span><strong>${value}</strong></div>`;
  }).join('')+`<div class="summary-row"><span>Tiebreak</span><strong>${tiebreak.value||'—'}</strong></div>`;
}

form.addEventListener('change',renderSummary);
tiebreak.addEventListener('input',renderSummary);

clearBtn.addEventListener('click',()=>{
  form.reset();
  validation.classList.add('hidden');
  renderSummary();
});

form.addEventListener('submit',event=>{
  event.preventDefault();
  const payload=currentPayload();
  const result=validatePickPayload(payload,{gameIds:games.map(g=>g.id),tiebreakRequired:true});
  if(!result.ok){
    validation.textContent=`Complete all ${games.length} games and enter a valid tiebreak total before submitting.`;
    validation.classList.remove('hidden');
    validation.focus?.();
    return;
  }
  validation.classList.add('hidden');
  for(const control of form.elements)control.disabled=true;
  submitBtn.textContent='Submitted';
  submittedCard.classList.remove('hidden');
  submittedCard.scrollIntoView({behavior:'smooth',block:'nearest'});
});

renderGames();
renderSummary();
if('serviceWorker' in navigator){navigator.serviceWorker.register('./service-worker.js').catch(()=>{})}
