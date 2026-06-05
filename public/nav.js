(() => {
  const nav = document.querySelector('[data-nav]');
  if (!nav) return;

  const path = location.pathname || '/';
  const isActive = (href) => {
    if (href === '/') return path === '/' || path === '/index.html';
    return path === href;
  };

  const items = [
    { href: '/', label: '代理池' },
    { href: '/nodes.html', label: '节点' },
    { href: '/accounts.html', label: '账号仓库' },
    { href: '/channels.html', label: '渠道配置' },
    { href: '/codes.html', label: '激活码' },
    { href: '/admin.html', label: '设备管理' },
    { href: '/tasks.html', label: '任务管理' },
    { href: '/task-stats.html', label: '任务统计' },
    { href: '/settings.html', label: '设置' },
  ];

  nav.innerHTML = items
    .map((it) => {
      const active = isActive(it.href);
      return `
        <a ${active ? 'class="active" aria-current="page"' : ''} href="${it.href}">
          <span class="dot" aria-hidden="true"></span>
          ${it.label}
        </a>
      `.trim();
    })
    .join('');

  const topActions = document.querySelector('.top-actions');
  if (!topActions) return;

  const syncBtn = document.createElement('button');
  syncBtn.type = 'button';
  syncBtn.className = 'btn';
  syncBtn.textContent = '同步到 MySQL';
  syncBtn.title = '把当前管理端本地数据全量同步到 MySQL';

  const logoutBtn = topActions.querySelector('#btnLogout');
  if (logoutBtn) {
    topActions.insertBefore(syncBtn, logoutBtn);
  } else {
    topActions.insertBefore(syncBtn, topActions.firstChild || null);
  }

  let syncStateTimer = null;
  const setSyncButtonState = (text, { disabled = false, title = '' } = {}) => {
    syncBtn.disabled = !!disabled;
    syncBtn.textContent = text;
    syncBtn.title = title || syncBtn.title || '';
  };

  const summarize = (summary) => {
    const s = summary && typeof summary === 'object' ? summary : {};
    return [
      `profiles ${Number(s.profiles || 0)}`,
      `pool ${Number(s.poolItems || 0)}`,
      `nodes ${Number(s.nodes || 0)}`,
      `machines ${Number(s.machines || 0)}`,
      `codes ${Number(s.activationCodes || 0)}`,
      `accounts ${Number(s.accounts || 0)}`,
      `changed ${Number(s.changedAuthStates || 0)}`,
    ].join(' · ');
  };

  const refreshCurrentPage = async () => {
    if (typeof window.refreshAll === 'function') {
      await window.refreshAll({ silent: true });
      return;
    }
    if (typeof window.refresh === 'function') {
      await window.refresh({ silent: true });
    }
  };

  syncBtn.addEventListener('click', async () => {
    clearTimeout(syncStateTimer);
    const defaultTitle = '把当前管理端本地数据全量同步到 MySQL';
    setSyncButtonState('同步中…', {
      disabled: true,
      title: `${defaultTitle}（执行中）`,
    });
    try {
      const res = await fetch('/v1/admin/sync/mysql', {
        method: 'POST',
        headers: { accept: 'application/json' },
      });
      if (res.status === 401) {
        const next = encodeURIComponent(location.pathname + location.search);
        location.href = `/login.html?next=${next}`;
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || `同步失败（HTTP ${res.status}）`);
      }
      const detail = summarize(data.summary);
      setSyncButtonState('同步完成', {
        title: detail || defaultTitle,
      });
      window.dispatchEvent(
        new CustomEvent('proxy-admin:mysql-synced', {
          detail: data,
        }),
      );
      await refreshCurrentPage().catch(() => {});
      syncStateTimer = setTimeout(() => {
        setSyncButtonState('同步到 MySQL', { title: defaultTitle });
      }, 2600);
    } catch (err) {
      const msg = err && err.message ? String(err.message) : '同步失败';
      setSyncButtonState('同步失败', {
        title: msg,
      });
      syncStateTimer = setTimeout(() => {
        setSyncButtonState('同步到 MySQL', { title: defaultTitle });
      }, 3600);
    } finally {
      syncBtn.disabled = false;
    }
  });
})();
