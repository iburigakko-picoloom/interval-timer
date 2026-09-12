export function durationSeconds(input) {
  const group = input.closest('.duration-input');
  if (!group) return Number(input.value);
  return [...group.querySelectorAll('input')].reduce((sum, field) => sum + Number(field.value) * Number(field.dataset.factor), 0);
}

export function setDuration(input, seconds) {
  const group = input.closest('.duration-input');
  if (!group) { input.value = seconds; return; }
  const fields = group.querySelectorAll('input');
  fields[0].value = Math.floor(seconds / 3600);
  fields[1].value = Math.floor(seconds % 3600 / 60);
  fields[2].value = seconds % 60;
  input.setCustomValidity('');
}

export function enhanceDuration(input, name, maxSeconds) {
  const initial = Number(input.value);
  const parent = input.parentElement;
  const fieldset = document.createElement('fieldset');
  fieldset.className = 'duration-field';
  const legend = document.createElement('legend');
  legend.textContent = name;
  const group = document.createElement('div');
  group.className = 'duration-input';
  for (const [unit, factor, max] of [['時', 3600, 24], ['分', 60, 59], ['秒', 1, 59]]) {
    const label = document.createElement('label');
    const field = factor === 1 ? input : document.createElement('input');
    field.type = 'number'; field.min = '0'; field.max = String(max);
    field.step = '1'; field.required = true; field.inputMode = 'numeric';
    field.dataset.factor = String(factor);
    field.setAttribute('aria-label', `${name}（${unit}）`);
    const caption = document.createElement('span'); caption.textContent = unit;
    label.append(field, caption); group.append(label);
  }
  fieldset.append(legend, group); parent.replaceWith(fieldset);
  const validate = () => {
    const total = durationSeconds(input);
    input.setCustomValidity(total < 1 || total > maxSeconds ? '1秒から24時間の範囲で入力してください' : '');
  };
  group.addEventListener('input', validate);
  setDuration(input, initial);
  for (const field of group.querySelectorAll('input')) field.defaultValue = field.value;
  validate();
}
