#!/usr/bin/env node
import {
  announceRemoteDestructiveTestTarget,
  assertDestructiveTestTarget,
  resolveTestRunId,
} from './live-test-safety.mjs';

try {
  const target = assertDestructiveTestTarget();
  const runId = resolveTestRunId();

  announceRemoteDestructiveTestTarget(target, { runId });

  if (process.argv.includes('--print-run-id')) {
    console.log(runId);
  }
} catch (error) {
  console.error(`[destructive-test-safety] ${error.message}`);
  process.exitCode = 1;
}
