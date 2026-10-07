#pragma once
// Tests invoke ISR functions explicitly; there is no host thread concurrency.
#define ATOMIC_RESTORESTATE 0
#define ATOMIC_BLOCK(mode) for (bool atomicOnce = true; atomicOnce; atomicOnce = false)
