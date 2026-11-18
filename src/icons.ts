import { Kind } from './model';

const itemArt = [
  '',
  '<path fill="#ad775d" d="m3 22 3-10 8-6 11 4 4 9-7 8H10Z"/><path fill="#e6ab83" d="m6 12 8-6 6 6-5 7-9-2Z"/><path d="m15 19 7 8m-2-15 5-2"/>',
  '<path fill="#597ba8" d="m3 25 4-12 6 3 4-12 9 3 3 13-7 7Z"/><path fill="#aedaf9" d="m13 16 4-12 6 6-4 13Z"/><path d="m7 13 3 11m13-14 3-3"/>',
  '<path fill="#a26739" d="m4 17 8-10 13 2 4 11-9 7-13-3Z"/><path fill="#ecab61" d="m12 7 13 2 4 11-13-3Z"/><path d="m4 17 12 0 4 10"/>',
  '<path fill="#7894a0" d="m4 20 16-5 8 5-16 6Z"/><path fill="#b1c6cc" d="m4 14 16-6 8 5-16 6Z"/><path fill="#e0eaec" d="m4 10 16-5 8 5-16 6Z"/>',
  '<ellipse cx="16" cy="16" rx="12" ry="9" fill="#797eb3"/><ellipse cx="17" cy="15" rx="9" ry="6" fill="#c6dafb"/><path d="m11 16 4-4m2 6 5-5" stroke="#65739e"/>',
  '<path fill="#5b9d99" d="M6 8h20v16H6z"/><path fill="#a7e2d3" d="M11 12h10v8H11z"/><path d="M3 11h3m-3 5h3m-3 5h3m20-10h3m-3 5h3m-3 5h3"/>',
  '<path fill="#c1924d" d="m5 10 13-6 9 6v13l-13 5-9-5Z"/><path fill="#f8d896" d="m5 10 9 5 13-5M14 15v13"/><path d="m9 13 13-6m-4 13 5-2"/>',
  '<path fill="#b28a58" d="m4 10 12-5 12 5v14l-12 4-12-4Z"/><path fill="#e5c58e" d="m4 10 12 5 12-5"/><path d="M16 15v13m-7-13 4 2m10 3v4"/>',
  '<path fill="#6caba9" d="M5 8h22v17H5z"/><path fill="#dfedd3" d="m9 15 4 3-4 3m6-6 4 3-4 3m6-6 4 3-4 3" stroke-width="2"/>',
];

const machineArt: Record<number,string> = {
  [Kind.Belt]:'<rect x="2" y="9" width="28" height="14" rx="4"/><path d="M8 9v14m16-14v14m-12-7h8m-3-3 3 3-3 3"/>',
  [Kind.FastBelt]:'<rect x="2" y="9" width="28" height="14" rx="4"/><path class="accent cyan" d="m8 12 4 4-4 4m6-8 4 4-4 4m6-8 4 4-4 4"/>',
  [Kind.ExpressBelt]:'<rect x="2" y="7" width="28" height="18" rx="3"/><path class="accent fuel" d="m7 11 4 5-4 5m7-10 4 5-4 5m7-10 4 5-4 5"/>',
  [Kind.Merger]:'<path d="M3 7h6l9 9h11M3 25h6l9-9m-12-12 3 3-3 3m0 12 3 3-3 3m19-15 4 3-4 3"/>',
  [Kind.Crossing]:'<path d="M4 11h7m10 0h7M4 21h7m10 0h7m-14-17h8v24h-8z"/><path d="M4 16h6m15 0h4m-3-3 3 3-3 3m-9-11v16m-3-4 3 4 3-4"/>',
  [Kind.IronDrill]:'<path d="M6 23V8h19v15M3 24h26M11 13h9l-5 9Zm4-2V6"/><path class="accent iron" d="m12 26 4-3 5 3-4 3Z"/>',
  [Kind.SilicaDrill]:'<path d="M4 24h24M7 23V11l9-7 9 7v12m-9-12v11m-5-6 5 6 5-6"/><path class="accent silica" d="m16 24 5 3-5 3-5-3Z"/>',
  [Kind.FuelDrill]:'<path d="M3 24h26M7 24V9h17v15m-12-6 10-6m-7 6 4 5m5-14h4v5"/><path class="accent fuel" d="m10 25 5-3 5 2 1 4-9 1Z"/>',
  [Kind.Smelter]:'<path d="M5 27V12l4-6h14l4 6v15ZM10 6V3h7v3"/><path class="accent fuel" d="M10 24v-4c0-3 3-4 4-7 1 3 5 4 6 8v3Z"/><path d="M20 10h4"/>',
  [Kind.Grinder]:'<path d="M5 6h22v21H5zM3 24h26"/><circle cx="16" cy="16" r="7"/><path class="accent silica" d="m16 11 4 5-4 5-4-5Z"/>',
  [Kind.Calibrator]:'<rect x="5" y="8" width="22" height="17" rx="2"/><path d="M10 5v3m6-3v3m6-3v3M10 25v3m6-3v3m6-3v3"/><path class="accent cyan" d="M13 12h6v3h3v4h-3v3h-6v-3h-3v-4h3Z"/>',
  [Kind.Assembler]:'<path d="M4 6h24v21H4Zm4 4v12m16-12v12M8 12l4 3m12-3-4 3"/><path class="accent fuel" d="m16 13 5 3v5l-5 3-5-3v-5Z"/>',
  [Kind.Generator]:'<path d="M4 9h24v17H4Zm17 0V5h5v4"/><circle cx="15" cy="17" r="6"/><path class="accent cyan" d="m16 11-4 7h3l-1 5 5-8h-4Z"/>',
  [Kind.Battery]:'<rect x="6" y="7" width="20" height="21" rx="2"/><path d="M13 7V4h6v3"/><path class="accent cyan" d="M10 12h3v11h-3zm6 0h3v11h-3zm6 0h1v11h-1z"/>',
  [Kind.Solar]:'<path class="accent cyan" d="M7 7h20l-4 14H3Z"/><path d="m12 7-4 14m12-14-4 14M5 14h20m-9 7v6m-6 0h12"/>',
  [Kind.Depot]:'<path d="m4 10 12-5 12 5v14l-12 4-12-4Zm0 0 12 5 12-5m-12 5v13m-6-13v8m12-8v8"/>',
  [Kind.Station]:'<path d="M6 7c-4 10 7 18 15 12L6 7Zm10 10 6-10m-6 12v7m-7 0h14"/><circle class="accent fuel" cx="23" cy="6" r="2"/>',
  [Kind.KitPress]:'<path d="M5 27V5h22v22M9 10h14m-7 0v6m-5 0h10M4 27h24"/><path class="accent fuel" d="M10 21h12v6H10z"/>',
  [Kind.Splitter]:'<path d="M3 11h14l10-5v7l-9 4 9 4v7l-10-5H3Zm5 6h8m4-8 4 2-4 2m0 8 4 2-4 2"/>',
  [Kind.Kiln]:'<path d="M4 26V14a12 9 0 0 1 24 0v12ZM21 7V4h5v6"/><path class="accent fuel" d="M9 23v-4a7 5 0 0 1 14 0v4Z"/><path d="M12 19v2m4-3v3m4-2v2" stroke="#754527"/>',
  [Kind.SimpleMiner]:'<path d="M4 26h23M7 24V8h15v16M7 11h15m-7 0v9m-4-2 4 4 4-4"/><path class="accent iron" d="m11 25 4-2 5 2-4 3Z"/>',
  [Kind.Bench]:'<path d="M4 25h24M7 25V9h18v16M10 12h12m-6 0v6m-7 3h14"/><path class="accent cyan" d="M13 18h6v3h-6z"/>',
  [Kind.Yard]:'<path d="M4 7h24v18H4zm0 7h24M7 20h18m-14 0v5m10-5v5"/><path d="M9 10h4m6 0h4"/>',
  [Kind.DevelopmentHub]:'<rect x="4" y="4" width="24" height="24" rx="6"/><path class="accent fuel" d="M16 24V9m-6 6 6-6 6 6"/>',
};

export function itemIcon(item:number) {
  return `<svg class="item-icon" viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke="#263742" stroke-width="1.3" stroke-linejoin="round">${itemArt[item] ?? ''}</svg>`;
}

export function machineIcon(kind:number) {
  if (kind===Kind.IndustrialMiner) kind=Kind.IronDrill;
  const reinforced=kind>=Kind.ReinforcedIronDrill && kind<=Kind.ReinforcedMiner;
  if (reinforced) kind=kind===Kind.ReinforcedMiner?Kind.IronDrill:kind-Kind.ReinforcedIronDrill+Kind.IronDrill;
  return `<svg class="machine-icon" viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${machineArt[kind] ?? ''}${reinforced?'<path class="accent fuel" d="M22 5h5m-2.5-2.5v5"/>':''}</svg>`;
}

const actionArt = {
  hammer:'<g transform="rotate(24 12 12)" fill="currentColor" stroke="none"><path d="M9 8h4v12.5a2 2 0 0 1-4 0Z"/><path d="M2 3.5h4V5h8c4 0 6.8 2.4 7.7 6.3l-2.8-1.6-.6 2.2c-1.2-2.3-2.8-3.4-5.2-3.4H6V10H2Z"/></g>',
  rotate:'<path d="M20 10a8 8 0 1 0-2.8 8.1M20 4v6h-6"/>',
  cable:'<path d="M5 6h5a4 4 0 0 1 0 8h-1a3 3 0 1 0 0 6h5a3 3 0 0 0 3-3v-3"/><path d="M2 4h3v4H2m13 6V9h4v5Zm1-5V6m2 3V6"/>',
};

export function actionIcon(name:keyof typeof actionArt) {
  return `<svg class="action-icon action-icon--${name}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${actionArt[name]}</svg>`;
}
