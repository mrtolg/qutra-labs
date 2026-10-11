// Applies the persisted appearance before first paint.
// Classic external script for CSP script-src 'self'. Mirrors appearance resolve.
(function () {
  function clock(v) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(v || "");
    if (!m) return null;
    var h = +m[1], min = +m[2];
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }
  function resolveMode(prefs, osDark) {
    var theme = prefs && prefs.theme ? prefs.theme : "system";
    if (theme === "light") return "light";
    if (theme === "dark") return "dark";
    var tm = (prefs && prefs.themeMode) || "system";
    if (tm === "light" || tm === "dark") return tm;
    if (tm === "schedule") {
      var light = clock(prefs && prefs.themeScheduleLightAt); if (light == null) light = 7 * 60;
      var dark = clock(prefs && prefs.themeScheduleDarkAt); if (dark == null) dark = 19 * 60;
      var now = new Date(); var cur = now.getHours() * 60 + now.getMinutes();
      var inDark = dark === light ? false : (dark < light ? (cur >= dark && cur < light) : (cur >= dark || cur < light));
      return inDark ? "dark" : "light";
    }
    return osDark ? "dark" : "light";
  }
  try {
    var raw = localStorage.getItem("contextos.v1.preferences");
    var prefs = raw ? JSON.parse(raw) : null;
    var osDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    var mode = resolveMode(prefs, osDark);
    var packId = (prefs && prefs.packId) || "contextos";
    var material = (prefs && prefs.material) || "none";
    var theme = prefs && prefs.theme ? prefs.theme : "system";
    if (theme === "windows" && material === "none") material = "mica";
    if (prefs && prefs.highContrast || packId === "highContrast" || theme === "highContrast") {
      packId = "highContrast";
      material = "none";
    }
    var themeAttr = packId === "catppuccin" ? "catppuccin" : packId === "highContrast" ? "highContrast" : "contextos";
    var root = document.documentElement;
    root.dataset.theme = themeAttr;
    root.dataset.pack = packId;
    root.dataset.mode = mode;
    root.dataset.requestedMaterial = material;
    root.dataset.nativeBackdrop = "none";
    root.dataset.chromeTreatment = material === "liquidGlass" ? "refractive" : "solid";
    root.style.colorScheme = mode;
    if (prefs && prefs.density) root.dataset.density = prefs.density;
    if (prefs && prefs.highContrast || packId === "highContrast") root.dataset.contrast = "high";
    if (prefs && prefs.reduceMotion) root.dataset.reduceMotion = "true";
    if (prefs && prefs.reduceTransparency) root.dataset.reduceTransparency = "true";
    if (prefs && prefs.locale) root.lang = prefs.locale;
  } catch (e) {
    document.documentElement.dataset.theme = "contextos";
    document.documentElement.dataset.pack = "contextos";
    document.documentElement.dataset.mode = "light";
    document.documentElement.style.colorScheme = "light";
  }
})();
