// A wall-free board (what Zip looks like once completed) is under-constrained:
// many Hamiltonian paths satisfy it, and the old code would draw one of them.
const fs=require('fs'),vm=require('vm');
const ctx={console}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync('/Users/Games/Desktop/Code/LockedIn/games/zip/solver.js','utf8'),ctx);
const mk=(n)=>Array.from({length:n},()=>Array.from({length:n},()=>({top:false,bottom:false,left:false,right:false})));
const n=6, wps=new Map([['0,0',1],['5,5',2]]);

let w=mk(n);
let r=ctx.solveZipSolutions({size:n,waypoints:wps,walls:w},2);
console.log(`no walls (completed board):  ${r.solutions.length} solution(s) found -> ${r.solutions.length>1?'flagged under-constrained, refuses to draw':'would draw'}`);

// A heavily walled board: one forced serpentine route.
w=mk(n);
for(let row=0;row<n-1;row++){
  for(let c=0;c<n;c++){
    const gap = row%2===0 ? n-1 : 0;      // single opening alternating sides
    if(c!==gap){ w[row][c].bottom=true; w[row+1][c].top=true; }
  }
}
r=ctx.solveZipSolutions({size:n,waypoints:wps,walls:w},2);
console.log(`fully walled (real board):   ${r.solutions.length} solution(s) found -> ${r.solutions.length===1?'unique, draws it':'ambiguous'}`);
console.log(`  budget exhausted: ${r.exhaustedBudget}`);
const p=ctx.solveZip({size:n,waypoints:wps,walls:w});
console.log(`  solveZip wrapper still returns a path: ${p?`yes (${p.length} cells)`:'no'}`);
