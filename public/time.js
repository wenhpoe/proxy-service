(() => {
  function fmtChinaTime(input) {
    const s = String(input || "").trim();
    if (!s) return "—";
    const t = Date.parse(s);
    if (!Number.isFinite(t)) return s;
    const d = new Date(t);
    try {
      const parts = new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).formatToParts(d);
      const get = (type) => parts.find((p) => p.type === type)?.value || "";
      return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
    } catch {
      // Fallback: may include locale separators, but still forces Asia/Shanghai.
      try {
        return d.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
      } catch {
        return s;
      }
    }
  }

  window.fmaFmtChinaTime = fmtChinaTime;
})();

