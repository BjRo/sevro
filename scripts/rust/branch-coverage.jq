# Invoke with jq --exit-status --slurp --from-file <this file> <report.json>.
# The bound keeps multiplication by 100 exact with jq's binary64 arithmetic.
def exact_counter:
  type == "number" and . >= 0 and . == floor and . <= 90071992547409;

if length != 1 then error("Expected exactly one LLVM coverage document") else .[0] end
| if .type != "llvm.coverage.json.export" or .version != "3.1.0"
  then error("Expected LLVM coverage JSON version 3.1.0") else . end
| if .cargo_llvm_cov.version != "0.9.1"
  then error("Expected cargo-llvm-cov version 0.9.1") else . end
| if (.data | type != "array" or length != 1)
  then error("Expected exactly one LLVM coverage dataset") else . end
| .data[0].totals.branches
| if (type != "object")
     or ((.count | exact_counter) | not)
     or ((.covered | exact_counter) | not)
     or ((.notcovered | exact_counter) | not)
  then error("Missing or invalid LLVM branch counters") else . end
| if .count == 0 or .covered > .count or .notcovered != (.count - .covered)
  then error("Expected nonzero, consistent LLVM branch counters") else . end
| if .covered * 100 < .count * 95
  then error("Below 95% LLVM branch coverage: \(.covered)/\(.count)")
  else {
    metric: "LLVM supported branch outcomes",
    covered: .covered,
    total: .count,
    requiredPercent: 95,
    passed: true
  } end
