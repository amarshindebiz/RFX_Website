document.getElementById('nav-placeholder').outerHTML = buildNav('Products');
document.getElementById('footer-placeholder').outerHTML = buildFooter();
const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
const heroImage = document.getElementById('hero-image');
const heroPanel = document.getElementById('hero-render');
function selectRender(tab) {
  tabs.forEach(item => {
    item.setAttribute('aria-selected', String(item === tab));
    item.tabIndex = item === tab ? 0 : -1;
  });
  heroImage.src = './assets/' + tab.dataset.image;
  heroImage.alt = tab.dataset.alt;
  heroPanel.setAttribute('aria-labelledby', tab.id);
}
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectRender(tab));
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next !== undefined) {
      event.preventDefault();
      tabs[next].focus();
      selectRender(tabs[next]);
    }
  });
});
