#pragma once

namespace dental { namespace storage {

// One execution context owns FatFs. A background call may yield only after a
// complete FatFs API call returns, never from disk_read/disk_write or an ISR.
class ForegroundStoragePriority {
 public:
  void beginBackground() { background_ = true; }
  void endBackground() { background_ = paused_ = replacing_ = false; }
  bool background() const { return background_ && !paused_; }
  bool preemptible() const { return background() && !replacing_; }
  bool replacing() const { return replacing_; }
  void pause() { paused_ = true; }
  void resume() { paused_ = false; }
  bool beginReplacement(bool foregroundPending, bool pendingInterlock) {
    if (foregroundPending || pendingInterlock) return false;
    replacing_ = true; return true;
  }
  void endReplacement() { replacing_ = false; }
 private:
  bool background_ = false, paused_ = false, replacing_ = false;
};

} }
