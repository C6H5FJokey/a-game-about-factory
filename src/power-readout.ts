import { CITY, CityField, Field, Kind, cell, cityValue, energyMj, mw } from './model';
import { design, deviceAt } from './sim-data';

export function designPower(kind:number):string {
  const entry=design(kind);
  if (!entry) return '';
  if (kind===Kind.Station) return `发射 ${mw(entry.demand)} · 跟踪功率按站点`;
  if (entry.demand) return `额定耗电 ${mw(entry.demand)}`;
  if (entry.generation) return `额定发电 ${mw(entry.generation)}`;
  if (entry.batteryPower) return `充放电上限 ${mw(entry.batteryPower)}`;
  return '无需电网供电';
}

export function devicePower(data:Int32Array,tile:number,kind:Kind):[string,string][] {
  const actual=deviceAt(data,tile), rated=design(kind);
  if (!actual || !rated) return [];
  if (rated.batteryPower) return [
    ['已储能',`${energyMj(cell(data,tile,Field.Energy)).toFixed(1)} / ${energyMj(rated.batteryCapacity)} MJ`],
    ['当前充电',mw(actual.charged)],['当前放电',mw(actual.discharged)],['充放电上限',mw(rated.batteryPower)],
  ];
  if (rated.generation) return [['当前发电',mw(actual.generated)],['额定发电',mw(rated.generation)]];
  if (kind===Kind.Station) {
    const city=CITY.findIndex((_,i)=>cityValue(data,i,CityField.Site)===tile);
    const rows:[string,string][]=[['当前需求',mw(actual.demand)],['当前耗电',mw(actual.used)]];
    if (city>=0) rows.push(['额定跟踪功率',mw(cityValue(data,city,CityField.Power))]);
    if (city===0) rows.push(['额定发射功率',mw(rated.demand)]);
    return rows;
  }
  if (rated.demand) return [
    ['当前需求',mw(actual.demand)],['当前耗电',mw(actual.used)],
    ['额定运转功率',mw(rated.demand)],
  ];
  return [];
}
