function createPager({
  sizeSel,
  prevBtn,
  nextBtn,
  infoEl,
  defaultPageSize = 15,
  sizes = [10, 15, 20],
  onChange,
} = {}) {
  if (!sizeSel || !prevBtn || !nextBtn || !infoEl) throw new Error("分页组件缺少必要元素");

  let page = 1;
  let pageSize = defaultPageSize;
  let totalItems = 0;
  let totalPages = 1;

  function clamp() {
    totalPages = Math.max(1, Math.ceil(Math.max(0, totalItems) / Math.max(1, pageSize)));
    page = Math.min(Math.max(1, page), totalPages);
  }

  function renderControls() {
    prevBtn.disabled = page <= 1;
    nextBtn.disabled = page >= totalPages;
    infoEl.textContent = `第 ${page} / ${totalPages} 页 · 共 ${totalItems} 条`;
  }

  function setTotal(n) {
    totalItems = Number.isFinite(Number(n)) ? Number(n) : 0;
    clamp();
    renderControls();
  }

  function setPageSize(n) {
    const nn = Number(n);
    if (!Number.isFinite(nn) || nn <= 0) return;
    pageSize = nn;
    page = 1;
    setTotal(totalItems);
  }

  function init() {
    sizeSel.innerHTML = "";
    for (const s of sizes) {
      const opt = document.createElement("option");
      opt.value = String(s);
      opt.textContent = `每页 ${s}`;
      if (s === defaultPageSize) opt.selected = true;
      sizeSel.appendChild(opt);
    }

    sizeSel.addEventListener("change", () => {
      setPageSize(Number(sizeSel.value));
      if (typeof onChange === "function") onChange();
    });

    prevBtn.addEventListener("click", () => {
      page = Math.max(1, page - 1);
      renderControls();
      if (typeof onChange === "function") onChange();
    });
    nextBtn.addEventListener("click", () => {
      page = Math.min(totalPages, page + 1);
      renderControls();
      if (typeof onChange === "function") onChange();
    });

    setTotal(0);
  }

  function reset() {
    page = 1;
    renderControls();
  }

  function slice(items) {
    const list = Array.isArray(items) ? items : [];
    setTotal(list.length);
    const start = (page - 1) * pageSize;
    return list.slice(start, start + pageSize);
  }

  init();

  return {
    slice,
    reset,
    setTotal,
    get page() {
      return page;
    },
    get pageSize() {
      return pageSize;
    },
    get totalItems() {
      return totalItems;
    },
    get totalPages() {
      return totalPages;
    },
  };
}

window.createPager = createPager;
