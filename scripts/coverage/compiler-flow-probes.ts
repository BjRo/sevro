import { analyzeCompilerFlow } from "./compiler-flow";
import { analyzeCounterCopies } from "./compiler-counter-copy";

const proved = [
  [
    "counter-copy-unknown",
    "let errors=0; for(let i=0;i<input;i++){errors++;} const _errs0=errors; if(errors===_errs0){return true;} return false;",
  ],
  [
    "constant-local",
    "let errors=0; if(errors===0){return true;} return false;",
  ],
  [
    "identical-join",
    "let errors=0; if(input){errors=1;}else{errors=1;} if(errors===1){return true;} return false;",
  ],
  [
    "terminated-arm",
    "let errors=0; if(input){errors=1;return false;} if(errors===0){return true;} return false;",
  ],
] as const;
const declined = [
  ["foreign-counter-value", "let errors=0; errors=input; const _errs0=errors; if(errors===_errs0){return true;} return false;"],
  [
    "labeled-block",
    "let errors=0; label:{if(input){break label;} errors=1;} if(errors===1){return true;} return false;",
  ],
  [
    "short-circuit-primitive",
    "let valid0=input||true; if(valid0===true){return true;} return false;",
  ],
  [
    "changed-counter-copy",
    "let errors=input; const _errs0=errors; errors=input.other; if(errors===_errs0){return true;} return false;",
  ],
  [
    "dynamic-evaluation",
    "let errors=0; eval(input); if(errors===0){return true;} return false;",
  ],
  [
    "unsupported-expression",
    "let errors=0; if((input(), errors===0)){return true;} return false;",
  ],
  [
    "assignment",
    "let errors=0; errors=input; if(errors===0){return true;} return false;",
  ],
  [
    "different-join",
    "let errors=0; if(input){errors=1;} if(errors===0){return true;} return false;",
  ],
  [
    "loop-write",
    "let errors=0; while(input){errors++;} if(errors===0){return true;} return false;",
  ],
  [
    "shadowing",
    "let errors=0; {let errors=input; if(errors===0){return true;}} return false;",
  ],
  [
    "captured-local",
    "let errors=0; const change=()=>{errors=1}; input(change); if(errors===0){return true;} return false;",
  ],
  [
    "unsupported-syntax",
    "let errors=0; try{input();}catch{errors=1;} if(errors===0){return true;} return false;",
  ],
  [
    "destructuring-write",
    "let errors=0; ({errors}=input); if(errors===0){return true;} return false;",
  ],
  [
    "malformed-syntax",
    "let errors=0; let = ; if(errors===0){return true;} return false;",
  ],
] as const;

export function compilerFlowProbe(): void {
  for (const [name, body] of proved) {
    if (!analyzed(`function validate(input){${body}}`).length)
      throw new Error(`Compiler proof declined ${name}`);
    console.log(`${name}: proved`);
  }
  for (const [name, body] of declined) {
    if (analyzed(`function validate(input){${body}}`).length)
      throw new Error(`Compiler proof unsafely accepted ${name}`);
    console.log(`${name}: declined`);
  }
}

function analyzed(source: string) {
  return [...analyzeCompilerFlow(source), ...analyzeCounterCopies(source)];
}
