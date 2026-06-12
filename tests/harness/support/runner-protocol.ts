/**
 * tests/harness/support/runner-protocol.ts — the stdout marker protocol
 * between the crash-drill parent (vitest) and the child wallet runner.
 * Lives apart from send-runner.ts so importing the constants never imports
 * (and runs) the runner entrypoint.
 */

export const KILL_POINT_MARKER = 'HARNESS_KILL_POINT';
export const RESUME_RESULT_MARKER = 'HARNESS_RESUME_RESULT';
export const LOADED_MARKER = 'HARNESS_LOADED';
