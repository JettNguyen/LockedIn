// Does the payload scanner surface embedded answers if they're there?
const fs=require('fs'),vm=require('vm');
const ROOT='/Users/Games/Desktop/Code/LockedIn';
const blob={tagName:'code',id:'bpr-guid-9911',attributes:[],getAttribute:()=>null,
  textContent:JSON.stringify({included:[{ $type:'com.linkedin.games.CrossclimbPuzzle',
    clues:[{clueText:'Chowder ingredient',answerWord:'CLAM'},{clueText:'Scottish family',answerWord:'CLAN'}],
    solutionOrder:[3,1,2],bonusAnswer:'SLAM'}]})};
const rows=[];
function makeRow(id){const inputs=Array.from({length:4},(_,i)=>({value:'',dataset:{crossclimbGuessInputIdx:String(i)}}));
  return {dataset:{guessId:String(id)},querySelectorAll:(s)=>s.includes('guess-input-idx')?inputs:[],
    querySelector:()=>null,closest:()=>null};}
for(let i=0;i<7;i++) rows.push(makeRow(i));
const grid={querySelectorAll:(s)=>s.includes('data-guess-id')?rows:[]};
const ctx={console,Set,Map,Array,Number,String,RegExp,Math,JSON,Promise,Infinity,Object,
  document:{querySelector:(s)=>s.includes('crossclimb')?grid:null,
    querySelectorAll:(s)=>s.includes('code')?[blob]:[],body:{}},
  fetch:async(p)=>({ok:true,text:async()=>fs.readFileSync(`${ROOT}/${p}`,'utf8')}),
  chrome:{runtime:{getURL:(p)=>p}}};
ctx.window=ctx;vm.createContext(ctx);
vm.runInContext(fs.readFileSync(`${ROOT}/shared/detect.js`,'utf8'),ctx);
vm.runInContext(fs.readFileSync(`${ROOT}/shared/wordlist.js`,'utf8'),ctx);
ctx.LockedInOverlay={show:()=>{}};
vm.runInContext(fs.readFileSync(`${ROOT}/games/crossclimb/game.js`,'utf8'),ctx);
ctx.LockedInGames[0].diagnose().then(t=>console.log(t.split('\n').slice(0,8).join('\n')));
