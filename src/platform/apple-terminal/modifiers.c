// Minimal Node-API probe for the Apple Terminal Shift+Return workaround.
// It reads Quartz's current session modifier flags; it does not install an
// event tap, subscribe to input, or post keyboard events.

#include <ApplicationServices/ApplicationServices.h>
#include <node_api.h>

static napi_value is_shift_pressed(napi_env env, napi_callback_info info) {
  (void)info;

  const CGEventFlags flags =
      CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState);
  napi_value result;
  napi_get_boolean(env, (flags & kCGEventFlagMaskShift) != 0, &result);
  return result;
}

NAPI_MODULE_INIT() {
  const napi_property_descriptor properties[] = {
      {
          .utf8name = "isShiftPressed",
          .method = is_shift_pressed,
          .attributes = napi_default,
      },
  };

  napi_define_properties(
      env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}
