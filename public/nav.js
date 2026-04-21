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
    { href: '/codes.html', label: '激活码' },
    { href: '/admin.html', label: '设备管理' },
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
})();
