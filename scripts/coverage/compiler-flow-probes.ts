import { analyzeCompilerFlow } from "./compiler-flow";
import { analyzeCounterCopies } from "./compiler-counter-copy";

const proved = [
  [
    "literal-array-length",
    "let errors=0;let vErrors=null;vErrors=[];errors=vErrors.length;const _errs0=errors;if(errors===_errs0){return true;}return false;",
  ],
  ["zero-counter-truth", "let errors=0; if(errors){return false;}return true;"],
  [
    "increment-counter",
    "let errors=0;errors++;if(errors===1){return true;}return false;",
  ],
  [
    "local-array-binding",
    "let vErrors=null;vErrors=[];if(vErrors===null){return false;}return true;",
  ],
  [
    "null-join",
    "let vErrors=input;if(vErrors!==null){vErrors=null;}if(vErrors===null){return true;}return false;",
  ],
  [
    "array-mutation",
    "let vErrors=[];input(vErrors);if(vErrors===null){return false;}return true;",
  ],
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
  [
    "infinite-literal-negation",
    "let errors=1e309;if(!errors){return true;}return false;",
  ],
  [
    "overflow-literal-negation",
    "let errors=9007199254740992;if(!errors){return true;}return false;",
  ],
  [
    "fractional-counter",
    "let errors=0.5;if(errors===0.5){return true;}return false;",
  ],
  [
    "nan-counter",
    "let errors=NaN;const _errs0=errors;if(errors===_errs0){return true;}return false;",
  ],
  [
    "negative-counter",
    "let errors=-1;errors++;if(errors===0){return true;}return false;",
  ],
  [
    "infinite-counter",
    "let errors=Infinity;errors++;if(errors===Infinity){return true;}return false;",
  ],
  [
    "counter-overflow",
    "let errors=9007199254740991;errors++;if(errors===9007199254740992){return true;}return false;",
  ],
  [
    "negative-decrement",
    "let errors=0;errors--;if(errors===-1){return true;}return false;",
  ],
  [
    "array-reassignment",
    "let vErrors=[];vErrors=input;if(vErrors===null){return true;}return false;",
  ],
  [
    "different-null-join",
    "let vErrors=[];if(input){vErrors=null;}if(vErrors===null){return true;}return false;",
  ],
  [
    "nonnull-truthiness",
    "let vErrors=input;if(vErrors===null){return true;}if(vErrors){return true;}return false;",
  ],
  [
    "global-counter-binding",
    "errors=0; input(); if(errors===0){return true;} return false;",
  ],
  [
    "foreign-counter-value",
    "let errors=0; errors=input; const _errs0=errors; if(errors===_errs0){return true;} return false;",
  ],
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
    declineProof(name, `function validate(input){${body}}`);
  }
  for (const [name, source] of unknownProperties) {
    declineProof(name, source);
  }
}

function declineProof(name: string, source: string): void {
  if (analyzed(source).length)
    throw new Error(`Compiler proof unsafely accepted ${name}`);
  console.log(`${name}: declined`);
}

const unknownProperties = [
  [
    "helper-error-property",
    "function helper(){let vErrors=null;helper.errors=vErrors;return false;}function validate(input){let errors=0;let vErrors=null;helper();vErrors=helper.errors;errors=vErrors.length;const _errs0=errors;if(errors===_errs0){return true;}return false;}",
  ],
  [
    "array-method-result",
    "function validate(input){let errors=0;let vErrors=null;vErrors=[];vErrors=vErrors.concat([]);errors=vErrors.length;const _errs0=errors;if(errors===_errs0){return true;}return false;}",
  ],
  [
    "conditional-counter-initialization",
    "function validate(input){if(input){var errors=0;}errors++;const _errs0=errors;if(errors===_errs0){return true;}return false;}",
  ],
  [
    "copy-before-initialization",
    "function validate(input){const _errs0=errors;var errors=0;errors=_errs0;errors++;const _errs1=errors;if(errors===_errs1){return true;}return false;}",
  ],
] as const;

function analyzed(source: string) {
  return [...analyzeCompilerFlow(source), ...analyzeCounterCopies(source)];
}
