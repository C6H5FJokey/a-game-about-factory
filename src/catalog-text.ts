import { content } from './generated-content';
import { onLanguageChange, t } from './i18n';

export const ITEM: string[] = [];
export const MACHINE: { name:string; detail:string }[] = [];
export const ERRORS: Record<number,string> = {};

function refreshCatalogText() {
  content.items.forEach((item, i) => { ITEM[i] = item ? t(item.nameKey) : ''; });
  content.machines.forEach((machine, i) => { MACHINE[i] = {name:t(machine.nameKey),detail:t(machine.descriptionKey)}; });
  for (let code=1;code<=25;code++) ERRORS[-code]=t('errors.'+code);
}
refreshCatalogText();
onLanguageChange(refreshCatalogText);

export function itemDescription(item:number) {
  const key=content.items[item]?.descriptionKey;
  return key ? t(key) : '';
}
