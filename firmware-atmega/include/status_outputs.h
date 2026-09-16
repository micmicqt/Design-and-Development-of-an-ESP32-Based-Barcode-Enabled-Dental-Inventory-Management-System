#pragma once

#include "status_encoding.h"

namespace dental_atmega {

void initializeStatusOutputs();
void setSmallStatus(SmallStatus status);
void setBigStatus(BigStatus status);

}  // namespace dental_atmega
