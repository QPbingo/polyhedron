/* Local visual preferences only; independent of demo session state. */
(() => {
  const palettes = [
    { id: 'electric', name: '电光蓝', detail: '钴蓝 × 冰青 · 清亮科技' },
    { id: 'iris', name: '鸢尾紫', detail: '亮紫 × 蜜桃 · 灵感创作' },
    { id: 'coral', name: '珊瑚橙', detail: '鲜橙 × 玫红 · 温暖活力' },
    { id: 'emerald', name: '翡翠绿', detail: '翠绿 × 青柠 · 清新轻快' },
    { id: 'rose', name: '玫瑰粉', detail: '玫粉 × 晴蓝 · 明快个性' },
    { id: 'original', name: '原版蓝青', detail: '柔蓝 × 浅青 · 对照原版' }
  ];
  const root = document.documentElement;
  let selected = 'electric';
  try {
    const requested = new URLSearchParams(location.search).get('palette');
    const saved = requested || localStorage.getItem('polyhedron-palette');
    if (palettes.some(p => p.id === saved)) selected = saved;
  } catch { /* File previews and restricted storage still support switching. */ }
  root.dataset.palette = selected;

  document.addEventListener('DOMContentLoaded', () => {
    const options = document.getElementById('palette-options');
    const current = document.getElementById('palette-current');
    function syncSelection() {
      for (const button of options.children) {
        button.setAttribute('aria-pressed', String(button.dataset.palette === selected));
      }
      current.textContent = palettes.find(p => p.id === selected).name;
    }
    for (const palette of palettes) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'palette-option';
      button.dataset.palette = palette.id;
      button.setAttribute('aria-label', `${palette.name}，${palette.detail}`);
      const swatches = document.createElement('span');
      swatches.className = 'palette-swatches';
      swatches.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < 4; i++) swatches.append(document.createElement('i'));
      const name = document.createElement('strong');
      name.textContent = palette.name;
      const detail = document.createElement('small');
      detail.textContent = palette.detail;
      button.append(swatches, name, detail);
      button.addEventListener('click', () => {
        selected = palette.id;
        root.dataset.palette = selected;
        syncSelection();
        try { localStorage.setItem('polyhedron-palette', selected); } catch { /* Optional preference. */ }
        try {
          const url = new URL(location.href);
          url.searchParams.set('palette', selected);
          history.replaceState(null, '', url);
        } catch { /* Direct file previews may restrict History. */ }
      });
      options.append(button);
    }
    syncSelection();
  });
})();
