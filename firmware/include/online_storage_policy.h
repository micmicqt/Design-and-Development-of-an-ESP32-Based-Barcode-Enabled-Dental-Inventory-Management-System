#pragma once

#include <stddef.h>

namespace dental::storage_policy {

// SQLite is authoritative online. Only offline scans require the SD cache and
// journal before a barcode may be accepted.
inline bool modeMayStart(bool offlineRoute, bool sdAvailable) {
  return !offlineRoute || sdAvailable;
}

// FatFs recovery is synchronous. Defer it while the desktop can deliver an
// online result, or while an online event/result is still outstanding.
inline bool mayRecover(bool desktopAvailable, size_t pendingOnlineEvents,
                       size_t pendingResultFeedbacks) {
  return !desktopAvailable && pendingOnlineEvents == 0U &&
         pendingResultFeedbacks == 0U;
}

inline bool emitSectorTrace(bool success, bool verbose) {
  return verbose || !success;
}

}  // namespace dental::storage_policy
