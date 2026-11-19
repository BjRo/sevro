/**
 * CLI: command dispatch for the installed `sevro` executable and the
 * invocation preparation and evaluation behind the embedding API.
 */
export { main } from "./command";
export { demoCommand } from "./demo";
export { informationCommand } from "./help";
export { initCommand } from "./init";
export { evaluateInvocation } from "./evaluation";
export { prepareRunInvocation } from "./preparation";
