import { createInstance } from 'i18next';
import { content } from './generated-content';

const storageKey = 'daybreak-language';
const defaultLanguage = 'zh-CN';
const translator = createInstance();
export const languages = Object.keys(content.locales);

function savedLanguage() {
  try {
    const value = localStorage.getItem(storageKey);
    if (value && languages.includes(value)) return value;
  } catch { /* A blocked browser preference store leaves the default active. */ }
  return defaultLanguage;
}

void translator.init({
  resources: Object.fromEntries(Object.entries(content.locales).map(([language, translation]) => [language, { translation }])),
  lng: savedLanguage(),
  supportedLngs: languages,
  fallbackLng: defaultLanguage,
  initAsync: false,
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
});

export function t(key:string, params?:Record<string,string|number>) {
  return translator.t(key, params);
}

export function language() { return translator.language || defaultLanguage; }

export function onLanguageChange(callback:()=>void) { translator.on('languageChanged', callback); }

export async function setLanguage(value:string) {
  if (!languages.includes(value)) return;
  await translator.changeLanguage(value);
  try { localStorage.setItem(storageKey,value); } catch { /* Switching still works for this session. */ }
}

export function textHtml(value:string|number) {
  return String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
}
