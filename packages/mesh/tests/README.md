# Timing tests

`controller-retry.test.ts` uses `TestClock` from `effect/testing` for mocked
writer tests of packet pacing, the shared send deadline, write timeouts, and
bounded disconnect cleanup. Install `TestClock.layer()` around the whole test
effect: it supplies both the clock and the tracking scheduler. The controller's
Promise-backed queue and cleanup capture these services from the caller.

Use `Deferred` gates to wait until the writer or cleanup has actually started
before advancing time. State allocation and lease release still perform real
filesystem I/O; wait for the next writer gate before the next clock advance.
Check just before and at each deadline to prove ordering rather than only
checking the final failure.

`TestClock` does not advance `Date.now()`, Node's `setTimeout`, native Bluetooth
Promises, or filesystem-lock polling. The mocked idle-close test keeps Vitest's
native timer control. Shared-lease and logger-context integration tests stay on
live time; native cancellation/disconnect coverage keeps its existing harness.
