#pragma once
#include <stdint.h>

namespace dental { namespace offline {
constexpr uint64_t kFirstDurableEventSequence = 0x8000000000000000ULL;

class EventSequenceStorage {
 public:
  virtual ~EventSequenceStorage() = default;
  virtual bool read(uint64_t& value, bool& present) = 0;
  virtual bool write(uint64_t value) = 0;
};

// Reservation reaches independent durable storage BEFORE any journal append.
// A torn append may leave a gap, never a reused identity. No volatile counter.
class DurableEventSequence {
 public:
  explicit DurableEventSequence(EventSequenceStorage& storage) : storage_(storage) {}
  bool reserve(uint64_t journalFloor, uint64_t& sequence) {
    sequence = 0;
    uint64_t stored = 0; bool present = false;
    if (!storage_.read(stored, present) ||
        (present && stored < kFirstDurableEventSequence)) return false;
    const uint64_t floor = stored > journalFloor ? stored : journalFloor;
    if (floor == UINT64_MAX) return false;
    const uint64_t next = floor < kFirstDurableEventSequence ?
        kFirstDurableEventSequence : floor + 1ULL;
    if (!storage_.write(next)) return false;
    uint64_t verified = 0; bool exists = false;
    if (!storage_.read(verified, exists) || !exists || verified != next) return false;
    sequence = next;
    return true;
  }
 private:
  EventSequenceStorage& storage_;
};
} }
