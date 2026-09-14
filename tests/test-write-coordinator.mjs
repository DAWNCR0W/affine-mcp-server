#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  WriteCoordinator,
  WriteCoordinatorError,
} from "../dist/util/writeCoordinator.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function assertQueueError(promise, code, retryable) {
  await assert.rejects(promise, error => {
    assert(error instanceof WriteCoordinatorError);
    assert.equal(error.code, code);
    assert.equal(error.retryable, retryable);
    return true;
  });
}

{
  const coordinator = new WriteCoordinator();
  const release = deferred();
  const events = [];
  const firstStarted = deferred();

  const first = coordinator.run("workspace-a", async () => {
    events.push("start:first");
    firstStarted.resolve();
    await release.promise;
    events.push("finish:first");
    return "first";
  });
  await firstStarted.promise;
  const second = coordinator.run("workspace-a", async () => {
    events.push("second");
    return "second";
  });
  const third = coordinator.run("workspace-a", async () => {
    events.push("third");
    return "third";
  });

  assert.deepEqual(events, ["start:first"]);
  release.resolve();
  assert.deepEqual(await Promise.all([first, second, third]), ["first", "second", "third"]);
  assert.deepEqual(events, ["start:first", "finish:first", "second", "third"]);
  assert.equal(coordinator.pendingScopeCount, 0);
}

{
  const coordinator = new WriteCoordinator();
  const release = deferred();
  const firstStarted = deferred();
  const otherStarted = deferred();

  const first = coordinator.run("workspace-a", async () => {
    firstStarted.resolve();
    await release.promise;
  });
  await firstStarted.promise;
  const other = coordinator.run("workspace-b", async () => {
    otherStarted.resolve();
    return "other";
  });

  await otherStarted.promise;
  release.resolve();
  await Promise.all([first, other]);
  assert.equal(coordinator.pendingScopeCount, 0);
}

{
  const coordinator = new WriteCoordinator();
  const release = deferred();
  const started = deferred();
  const first = coordinator.run("workspace-errors", async () => {
    started.resolve();
    await release.promise;
    throw new Error("expected operation failure");
  });
  await started.promise;
  const recovered = coordinator.run("workspace-errors", async () => "recovered");
  release.resolve();
  await assert.rejects(first, /expected operation failure/);
  assert.equal(await recovered, "recovered");
  assert.equal(coordinator.pendingScopeCount, 0);
}

{
  const coordinator = new WriteCoordinator();
  const release = deferred();
  const started = deferred();
  const first = coordinator.run("workspace-abort", async () => {
    started.resolve();
    await release.promise;
    return "finished";
  });
  await started.promise;

  const controller = new AbortController();
  let called = false;
  const queued = coordinator.run("workspace-abort", async () => {
    called = true;
    return "unexpected";
  }, controller.signal);
  controller.abort();
  await assertQueueError(queued, "WRITE_QUEUE_ABORTED", false);
  assert.equal(called, false);

  release.resolve();
  assert.equal(await first, "finished");
  assert.equal(coordinator.pendingScopeCount, 0);
}

{
  const coordinator = new WriteCoordinator({ maxWaitMs: 10 });
  const release = deferred();
  const started = deferred();
  const first = coordinator.run("workspace-timeout", async () => {
    started.resolve();
    await release.promise;
  });
  await started.promise;
  let called = false;
  const queued = coordinator.run("workspace-timeout", async () => {
    called = true;
  });
  let guardTimer;
  const guard = new Promise((_, reject) => {
    guardTimer = setTimeout(() => reject(new Error("queued timeout test did not settle")), 100);
  });
  try {
    await Promise.race([assertQueueError(queued, "WRITE_QUEUE_TIMEOUT", true), guard]);
  } finally {
    clearTimeout(guardTimer);
  }
  assert.equal(called, false);
  release.resolve();
  await first;
  assert.equal(coordinator.pendingScopeCount, 0);
}

{
  const coordinator = new WriteCoordinator({ maxPendingPerScope: 1 });
  const release = deferred();
  const started = deferred();
  const first = coordinator.run("workspace-bound", async () => {
    started.resolve();
    await release.promise;
  });
  await started.promise;
  const second = coordinator.run("workspace-bound", async () => "second");
  const third = coordinator.run("workspace-bound", async () => "unexpected");
  await assertQueueError(third, "WRITE_QUEUE_FULL", true);
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(coordinator.pendingScopeCount, 0);
}

{
  const coordinator = new WriteCoordinator();
  const release = deferred();
  const started = deferred();
  const controller = new AbortController();
  const first = coordinator.run("workspace-active-abort", async () => {
    started.resolve();
    await release.promise;
    return "still-held";
  }, controller.signal);
  await started.promise;
  const queued = coordinator.run("workspace-active-abort", async () => "after-active");
  controller.abort();
  await Promise.resolve();
  let settled = false;
  void queued.finally(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  release.resolve();
  assert.equal(await first, "still-held");
  assert.equal(await queued, "after-active");
  assert.equal(coordinator.pendingScopeCount, 0);
}

console.log("Write coordinator tests passed");
