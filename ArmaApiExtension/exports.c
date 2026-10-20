#include <stdint.h>

// Exported so Arma 3 can read the feature flags before the first call.
// 7 = ContextArgumentsVoidPtr | ContextStackTrace | ContextNoDefaultCall
__declspec(dllexport) uint64_t RVExtensionFeatureFlags = 7;

__declspec(dllexport) uint64_t RVExtensionGetFeatureFlags(void)
{
    return RVExtensionFeatureFlags;
}
