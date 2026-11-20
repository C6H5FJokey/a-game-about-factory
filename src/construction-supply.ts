import { ConstructionPaymentRecord, WarehouseRecord } from './generated-content';
import { constructionInventoryKey, type Material } from './sim-data';
import { checkRows } from './wire-read';

type Supply = {tile:number; used:Material[]};
type PaymentRequest = {type:'construction-payment'; request:number; anchor:number; words:number[]};

export class ConstructionSupply {
  private sequence=0;
  private current?:{key:string; request:number; rows:Supply[]};

  constructor(private send:(request:PaymentRequest)=>void) {}

  clear() { this.current=undefined; }

  preview(data:Int32Array,anchor:number|undefined,materials:readonly Material[]) {
    const inventory=anchor!==undefined && anchor>=0 ? constructionInventoryKey(data,materials) : '';
    if (!inventory || anchor===undefined) {
      this.clear();
      return [];
    }
    const words=materials.flatMap(({item,count})=>[item,count]);
    const key=`${anchor}:${words.join(',')}:${inventory}`;
    if (this.current?.key!==key) {
      const request=++this.sequence;
      this.current={key,request,rows:[]};
      this.send({type:'construction-payment',request,anchor,words});
    }
    return this.current.rows;
  }

  receive(request:number,buffer:ArrayBuffer) {
    if (this.current?.request!==request) return false;
    const words=new Int32Array(buffer);
    checkRows('ConstructionPayment',ConstructionPaymentRecord.words,words.length,WarehouseRecord.words);
    const rows:Supply[]=[];
    for (let i=ConstructionPaymentRecord.words;i<words.length;i+=WarehouseRecord.words) {
      const tile=words[i+WarehouseRecord.tile];
      let row=rows.at(-1);
      if (!row || row.tile!==tile) {
        row={tile,used:[]};
        rows.push(row);
      }
      row.used.push({item:words[i+WarehouseRecord.item],count:words[i+WarehouseRecord.count]});
    }
    this.current.rows=rows;
    return true;
  }
}
