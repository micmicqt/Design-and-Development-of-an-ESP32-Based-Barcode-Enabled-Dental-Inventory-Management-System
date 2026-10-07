#pragma once

#include <stdint.h>

namespace dental {
namespace storage {

enum class RuntimeSdFailure : uint8_t {
  kNone,
  kStatus,
  kRead,
  kWrite,
  kSync,
};

// Retain the first runtime failure; later 503s must not overwrite the clue.
class FirstRuntimeSdFailure {
 public:
  bool capture(RuntimeSdFailure operation, uint32_t sector = 0U) {
    if (operation == RuntimeSdFailure::kNone || operation_ != RuntimeSdFailure::kNone)
      return false;
    operation_ = operation;
    sector_ = sector;
    return true;
  }

  void clear() {
    operation_ = RuntimeSdFailure::kNone;
    sector_ = 0U;
  }

  RuntimeSdFailure operation() const { return operation_; }
  uint32_t sector() const { return sector_; }

 private:
  RuntimeSdFailure operation_ = RuntimeSdFailure::kNone;
  uint32_t sector_ = 0U;
};

}  // namespace storage
}  // namespace dental
