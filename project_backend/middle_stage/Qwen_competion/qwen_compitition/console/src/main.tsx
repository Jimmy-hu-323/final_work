// Keep the Android local-first product and the desktop QwenPaw console in
// separate module graphs. This prevents a mobile build from loading desktop
// plugin/bootstrap code or attempting any QwenPaw server requests.
if (MOBILE) {
  void import("./mobileMain");
} else {
  void import("./desktopMain");
}

