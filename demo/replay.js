/* Recorded example adapter. The unchanged application computes the proposal.
 * Only the exact recorded road requests are served; VROOM is explicitly absent.
 */
(() => {
  'use strict';
  const originalFetch = window.fetch.bind(window);
  const manifest = originalFetch('./demo/evidence/capture.json').then(response => {
    if (!response.ok) throw new Error('Recorded road manifest unavailable');
    return response.json();
  });
  window.ROUTER_CONFIG = {
    ...window.ROUTER_CONFIG,
    osrmEndpoint: 'https://router.project-osrm.org',
    vroomEndpoint: 'https://recorded-example.invalid/solve',
  };
  window.fetch = async (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin === location.origin && /\/data\/(depot|farms|products|restaurants|scenarios)\.json$/.test(url.pathname)) return originalFetch('./demo/data/' + url.pathname.split('/').pop());
    if (url.hostname === 'recorded-example.invalid') {
      return new Response('{"code":"VROOM-not-configured-in-recorded-example"}', {
        status: 503, headers: {'Content-Type': 'application/json'},
      });
    }
    if (url.hostname === 'router.project-osrm.org') {
      if ((options?.method || 'GET').toUpperCase() !== 'GET') throw new Error('Recorded road data supports GET requests');
      const fixture = (await manifest).osrm.find(item => item.url === url.href);
      if (!fixture) throw new Error('This route needs your configured road service. Open the full application to use your own data.');
      return originalFetch('./demo/evidence/' + fixture.file);
    }
    return originalFetch(input, options);
  };
  document.addEventListener('click', event => {
    if (event.target.closest('.pp-btn,.rep-row,#farm-cards,#product-cards')) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  const sizeHeader = () => {
    document.documentElement.style.setProperty('--nav-h', Math.ceil(document.querySelector('.nav').getBoundingClientRect().height) + 'px');
    window.dispatchEvent(new Event('resize'));
  };
  new ResizeObserver(sizeHeader).observe(document.querySelector('.nav'));
  const start = setInterval(() => {
    const scenario = document.querySelector('.scenario[data-id="barcelona-multi-stop"]');
    if (!scenario) return;
    clearInterval(start);
    scenario.click();
    document.querySelector('#calculate').click();
    // The example preserves map navigation, stock filtering and cost/report views.
    // Editing the catalogue or basket belongs to the full configured application.
    const controls = ['#open-scenarios', '#open-add-order', '#order-clear', '#farms-add', '#rc-clear'];
    for (const selector of controls) {
      const element = document.querySelector(selector);
      if (element) element.hidden = true;
    }
    const lock = () => {
      document.querySelectorAll('#order-lines button, #order-lines input, .stock-edit, .stock-remove, .qty-btn').forEach(element => {element.disabled = true;});
      if (document.querySelector('.calc-result')) document.querySelector('#calculate').disabled = true;
    };
    new MutationObserver(lock).observe(document.querySelector('.stage'), {childList:true, subtree:true});
    lock();
  }, 50);
  setTimeout(() => clearInterval(start), 20000);
})();
