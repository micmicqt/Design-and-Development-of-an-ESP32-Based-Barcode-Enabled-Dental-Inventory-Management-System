#include "runtime_sd_failure.h"

#include <assert.h>
#include <stdio.h>

int main() {
  using dental::storage::FirstRuntimeSdFailure;
  using dental::storage::RuntimeSdFailure;

  FirstRuntimeSdFailure first;
  assert(first.operation() == RuntimeSdFailure::kNone);
  assert(!first.capture(RuntimeSdFailure::kNone));
  assert(first.capture(RuntimeSdFailure::kRead, 42U));
  assert(first.operation() == RuntimeSdFailure::kRead);
  assert(first.sector() == 42U);
  assert(!first.capture(RuntimeSdFailure::kWrite, 99U));
  assert(!first.capture(RuntimeSdFailure::kSync));
  assert(first.operation() == RuntimeSdFailure::kRead && first.sector() == 42U);

  first.clear();
  assert(first.operation() == RuntimeSdFailure::kNone && first.sector() == 0U);
  assert(first.capture(RuntimeSdFailure::kSync));
  assert(first.operation() == RuntimeSdFailure::kSync);
  puts("Runtime MicroSD first-failure diagnostics: 11 focused checks PASSED");
}
