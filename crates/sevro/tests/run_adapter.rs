use std::path::Path;
use std::process::Command;

#[test]
fn executes_existing_typescript_adapter() {
    scenario("prompt-only");
}

#[test]
fn preserves_adapter_diagnostics_without_changing_parent_stderr() {
    scenario("stderr-descriptor");
}

#[test]
fn finishes_adapter_diagnostics_while_a_descendant_retains_stderr() {
    scenario("stderr-descendant");
}

#[test]
fn rejects_forged_final_message() {
    scenario("forged-message");
}

#[test]
fn retains_original_utf8_message() {
    scenario("raw-message");
}

#[test]
fn rejects_nonfinite_adapter_configuration() {
    scenario("nonfinite-configuration");
}

#[test]
fn rejects_date_adapter_configuration() {
    scenario("date-configuration");
}

#[test]
fn rejects_map_adapter_configuration() {
    scenario("map-configuration");
}

#[test]
fn rejects_class_adapter_configuration() {
    scenario("class-configuration");
}

#[test]
fn rejects_undefined_adapter_configuration() {
    scenario("undefined-configuration");
}

#[test]
fn rejects_accessor_adapter_configuration() {
    scenario("accessor-configuration");
}

#[test]
fn snapshots_original_adapter_configuration() {
    scenario("configuration-snapshot");
}

#[test]
fn preserves_null_prototype_adapter_configuration_identity() {
    scenario("null-prototype-configuration");
}

#[test]
fn ignores_adapter_configuration_serializer_getters() {
    scenario("configuration-serializer-getter");
}

#[test]
fn rejects_symbol_adapter_configuration() {
    scenario("symbol-configuration");
}

#[test]
fn retains_failed_adapter_receipt_and_usage() {
    scenario("partial-receipt");
}

#[test]
fn nan_cost_fails_after_retaining_trial() {
    scenario("nan-cost");
}

#[test]
fn null_cost_preserves_independently_complete_usage() {
    scenario("null-cost");
}

#[test]
fn oversized_receipt_discards_nan_cost_before_run_validation() {
    scenario("rejected-nan-cost");
}

#[test]
fn cancels_adapter_and_retains_partial_receipt() {
    scenario("cancellation");
}

#[test]
fn terminates_adapter_and_retains_partial_receipt() {
    scenario("termination");
}

#[test]
fn retains_adapter_binary_artifact_bytes() {
    scenario("binary-artifact");
}

#[test]
fn rejects_invalid_adapter_artifacts_and_exceeded_limits() {
    scenario("artifact-limits");
}

#[test]
fn retains_maximum_adapter_artifacts_with_message() {
    scenario("maximum-artifacts");
}

#[test]
fn rejects_malformed_adapter_instrumentation() {
    scenario("invalid-instrumentation");
}

#[test]
fn rejects_malformed_adapter_capability_ids() {
    scenario("invalid-capabilities");
}

#[test]
fn reports_bridge_exit_before_connection() {
    scenario("bridge-startup-failure");
}

#[test]
fn reports_unavailable_optional_bun_runtime() {
    scenario("unavailable-bun");
}

#[test]
fn preserves_result_exit_after_adapter_sets_process_exit_code() {
    scenario("adapter-exit-code");
}

#[test]
fn interrupts_pending_adapter_import_without_run_evidence() {
    scenario("import-interrupt");
}

#[test]
fn terminates_pending_adapter_import_without_run_evidence() {
    scenario("import-terminate");
}

#[test]
fn refuses_noncallable_adapter_run_before_admission() {
    scenario("noncallable-adapter-run");
}

#[test]
fn refuses_numeric_adapter_id_before_admission() {
    scenario("invalid-adapter-id");
}

#[test]
fn refuses_null_adapter_model_before_admission() {
    scenario("invalid-adapter-model");
}

#[test]
fn refuses_boolean_adapter_effort_before_admission() {
    scenario("invalid-adapter-effort");
}

#[test]
fn rejects_invalid_adapter_condition_evidence() {
    scenario("invalid-condition");
}

#[test]
fn preserves_completed_result_when_adapter_exit_hook_fails() {
    scenario("adapter-exit-hook");
}

fn scenario(name: &str) {
    let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = Command::new("bun")
        .arg(repository.join("tests/fixtures/rust-adapter-scenario.ts"))
        .arg(env!("CARGO_BIN_EXE_sevro"))
        .arg(name)
        .current_dir(repository)
        .output()
        .expect("Bun must be available for the existing TypeScript adapter contract");
    assert!(
        output.status.success(),
        "public adapter scenario failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
