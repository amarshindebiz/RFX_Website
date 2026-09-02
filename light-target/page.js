'use strict';
const shots = {
  'single-arnold': ['Light Target Single Light panel with an Arnold area light', 'Arnold single light', 1220],
  'single-redshift': ['Light Target Single Light panel with a Redshift area light', 'Redshift single light', 1320],
  'multi-light': ['Light Target Multi Light panel with two of three Arnold lights selected', 'Multi light selection', 1320]
};
document.querySelectorAll('[data-shot]').forEach(button => {
  button.addEventListener('click', () => {
    const key = button.dataset.shot;
    if (!Object.hasOwn(shots, key)) return;
    const img = document.getElementById('preview');
    img.src = 'assets/' + key + '.png';
    img.alt = shots[key][0];
    img.height = shots[key][2];
    document.getElementById('preview-link').href = img.src;
    document.getElementById('preview-note').firstChild.textContent = 'Actual plugin UI / ' + shots[key][1] + ' ';
    document.querySelectorAll('[data-shot]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  });
});
