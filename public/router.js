export function routeFromUrl(input) {
  const url = new URL(input, 'http://localhost'), parts = url.pathname.split('/').filter(Boolean);
  let view = ({ referral: 'referrals', referrals: 'referrals', home: 'home' })[parts[0]] || parts[0] || 'home';
  const route = { view, selectedProductId: null, selectedCategory: 'all', searchQuery: url.searchParams.get('q') || '', rewardCheckout: null, orderId: null };
  if (parts[0] === 'products' && parts[1] || url.searchParams.has('product')) { route.view = 'product'; route.selectedProductId = parts[1] || url.searchParams.get('product'); }
  if (parts[0] === 'orders' && parts[1]) { route.view = 'order-success'; route.orderId = parts[1]; }
  if (parts[0] === 'rewards' && parts[1] && parts[2] === 'checkout') { route.view = 'reward-checkout'; route.rewardCheckout = parts[1]; }
  if (parts[0] === 'categories' && parts[1]) route.selectedCategory = parts[1];
  if (['home','orders','notifications','referrals','offers'].includes(url.hash.slice(1))) route.view = url.hash.slice(1);
  if (!['home','cart','account','referrals','orders','checkout','categories','search','wishlist','offers','notifications','product','order-success','reward-checkout'].includes(route.view)) route.view = 'home';
  return route;
}
export function urlForState(state) {
  const id = encodeURIComponent;
  if (state.view === 'product' && state.selectedProductId) return `/products/${id(state.selectedProductId)}`;
  if (state.view === 'order-success' && (state.activeOrder?.id || state.orderId)) return `/orders/${id(state.activeOrder?.id || state.orderId)}`;
  if (state.view === 'reward-checkout' && state.rewardCheckout) return `/rewards/${id(state.rewardCheckout)}/checkout`;
  if (state.view === 'categories' && state.selectedCategory && state.selectedCategory !== 'all') return `/categories/${id(state.selectedCategory)}`;
  if (state.view === 'search') return `/search${state.searchQuery ? '?q=' + id(state.searchQuery) : ''}`;
  if (state.view === 'home') return '/';
  return `/${state.view === 'referrals' ? 'referral' : state.view === 'order-success' ? 'orders' : state.view}`;
}
export function createPageRouter({ window: win, readState, onNavigate }) {
  let restoring = false, restoringUrl = null, revision = 0;
  let lastUrl = win.location.pathname + win.location.search;
  let current = win.history.state?.puraina || { index: 0, scrollY: 0 };
  win.history.replaceState({ puraina: current }, '', win.location.href);
  const sync = state => {
    const next = urlForState(state);
    if (restoring && next === restoringUrl) return;
    if (restoring) { revision++; restoring = false; }
    if (next === lastUrl) return;
    win.history.replaceState({ puraina: { ...current, scrollY: win.scrollY || 0 } }, '', lastUrl);
    const replace = lastUrl.startsWith('/search') && next.startsWith('/search');
    current = { index: current.index + (replace ? 0 : 1), scrollY: 0 };
    win.history[replace ? 'replaceState' : 'pushState']({ puraina: current }, '', next);
    lastUrl = next;
  };
  async function restore() {
    const ticket = ++revision;
    restoring = true;
    current = win.history.state?.puraina || { index: 0, scrollY: 0 };
    lastUrl = win.location.pathname + win.location.search;
    const route = routeFromUrl(win.location.href);
    restoringUrl = urlForState(route);
    try { await onNavigate(route, () => ticket === revision); }
    finally {
      if (ticket === revision) { restoring = false; win.scrollTo({ top: current.scrollY || 0 }); }
    }
  }
  win.addEventListener('popstate', restore);
  win.addEventListener('hashchange', restore);
  return { sync, restore, back(fallback) { if (current.index > 0) win.history.back(); else { fallback(); sync(readState()); } }, dispose() { win.removeEventListener('popstate', restore); win.removeEventListener('hashchange', restore); } };
}
