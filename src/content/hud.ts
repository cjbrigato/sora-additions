import type { UIRefs } from './ui';

export function setPanelProgress(refs: UIRefs, pct?: number, main?: string, sub?: string) {
  refs.hudWrap.style.display = 'flex';
  if (typeof pct === 'number') refs.hudRing.style.setProperty('--pct', `${Math.max(0, Math.min(100, pct))}%`);
  refs.hudMain.textContent = main || '';
  refs.hudSub.textContent  = sub  || '';
}
export function hidePanelProgress(refs: UIRefs) {
  refs.hudWrap.style.display = 'none';
}
export function setMiniBadge(refs: UIRefs, text: string, phase: 'dl'|'zip'|undefined) {
  refs.badge.textContent = text || '';
  refs.badge.classList.remove('dl','zip');
  if      (phase === 'dl')  refs.badge.classList.add('dl');
  else if (phase === 'zip') refs.badge.classList.add('zip');
  refs.badge.style.display = (refs.panel.style.display === 'none') ? 'inline-block' : 'none';
}
export function clearMiniBadge(refs: UIRefs) {
  refs.badge.style.display = 'none';
  refs.badge.textContent = '';
  refs.badge.classList.remove('dl','zip');
}
