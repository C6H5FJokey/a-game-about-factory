import { held, Op, stackLimit, type Command } from './model';
import { deviceAt } from './sim-data';
import { canSelectSlot, readContainer, readSlot, sameSlot, type ContainerTarget, type Selection, type Slot } from './inventory-drag';
import { ITEM } from './catalog-text';
import { t } from './i18n';

export type BackpackStack=Pick<Slot,'item'|'stackIndex'>;
type InventoryDevice=Pick<Slot,'tile'|'identity'>;
type InventoryClick={slot:Slot; device:InventoryDevice; at:number; singleTransfer?:()=>void};
const INVENTORY_DOUBLE_CLICK_MS=350;

export const stackCount=(count:number,limit:number,index:number)=>Math.max(0,Math.min(limit,count-index*limit));
export function sameDevice(slot:InventoryDevice | undefined,device:InventoryDevice) {
  return slot?.tile===device.tile && slot.identity===device.identity;
}

export function createInventoryInteraction({
  snapshot,panel,panelBody,submit,say,closeInfo,revealInfo,refresh,
}:{
  snapshot:()=>Int32Array;
  panel:HTMLElement;
  panelBody:HTMLElement;
  submit:(command:Command,done?:(status:number)=>void)=>boolean;
  say:(message:string,error?:boolean)=>void;
  closeInfo:()=>void;
  revealInfo:(anchor:HTMLButtonElement,pin:boolean)=>void;
  refresh:()=>void;
}) {
  let selectedItem:Selection | undefined;
  let inventoryClick:InventoryClick | undefined;
  const pages=new Map<string,number>();
  function backpackStackCount({item,stackIndex}:BackpackStack) {
    const data=snapshot();
    return stackCount(held(data,item),stackLimit(data,item),stackIndex);
  }

  type TransferTarget=Pick<Slot,'role'|'item'|'tile'|'identity'|'canPut'>;

  function availableInSlot(source:Selection) {
    if (source.role==='held') return backpackStackCount(source);
    const device=deviceAt(snapshot(),source.tile);
    if (device?.identity!==source.identity) return 0;
    const slot=device.slots.find(slot=>slot.canTake && slot.role===source.role && slot.item===source.item);
    return slot?stackCount(slot.count,slot.stack,source.stackIndex):0;
  }

  function transferSlot(source:Selection,target:TransferTarget) {
    const {role,item,tile,identity,canPut}=target;
    const insert=source.role==='held' && (role==='input' || role==='module') && canPut;
    const extract=role==='held' && (source.role==='input' || source.role==='output' || source.role==='module' || source.role==='cargo');
    if (!insert && !extract) return false;
    if (source.item!==item) {
      say('所选物料与槽位不符。',true);
      return false;
    }
    if (source.role==='cargo') return takeCargo(source.tile,source.lane,item,source.cargoId,source.identity);
    const available=availableInSlot(source);
    if (!available) return false;
    return submit({op:Op.Transfer,a:source.tile,b:tile,c:item,
      words:[Math.min(source.quantity ?? available,available),source.identity,identity,source.role==='module'||role==='module'?3:source.role==='input'?1:2]},quantity=>{
      selectedItem=undefined;
      say(t(role==='module'?'ui.installed':role==='input'?'ui.inserted':'ui.received',{item:ITEM[item],count:quantity}));
    });
  }

  function transferToContainer(source:Selection,{tile,identity}:ContainerTarget) {
    return transferSlot(source,{role:tile===-1?'held':'input',item:source.item,tile,identity,canPut:true});
  }

  function takeCargo(tile:number,lane:number,item:number,cargoId:number,identity:number) {
    return submit({op:Op.TakeCargo,a:tile,b:lane,c:item,words:[cargoId,identity]},()=>{
      selectedItem=undefined;
      say(t('ui.received',{item:ITEM[item],count:1}));
    });
  }

  function openInventory() {
    if (panel.dataset.expanded!=='true') return undefined;
    const container=readContainer(panelBody.querySelector('[data-container]'));
    if (container) return container;
    const slot=panelBody.querySelector<HTMLButtonElement>('[data-slot="input"],[data-slot="output"],[data-slot="module"]');
    return slot?readSlot(slot):undefined;
  }

  function quickTransfer(slot:Slot) {
    if (!slot.count) return;
    if (slot.role==='held') {
      const container=readContainer(panelBody.querySelector('[data-container]'));
      if (container) {
        if (transferToContainer(slot,container)) closeInfo();
        return;
      }
      const target=panelBody.querySelector<HTMLButtonElement>(`button[data-item="${slot.item}"][data-put="true"]`);
      if (target && transferSlot(slot,readSlot(target))) closeInfo();
    } else if (slot.canTake && transferSlot(slot,{role:'held',item:slot.item,tile:-1,identity:0,canPut:false})) {
      closeInfo();
    }
  }

  function activateSlot(anchor:HTMLButtonElement,event:MouseEvent) {
    const slot=readSlot(anchor), {role,item,canPut}=slot;
    const device=event.detail>0 && role!=='cargo' && role!=='display'?openInventory():undefined;
    const previous=inventoryClick;
    inventoryClick=undefined;
    if (device && previous && sameDevice(device,previous.device) && sameSlot(previous.slot,slot) &&
        event.timeStamp-previous.at<=INVENTORY_DOUBLE_CLICK_MS) {
      quickTransfer(slot);
      return;
    }
    previous?.singleTransfer?.();
    const click:InventoryClick | undefined=device?{slot,device,at:event.timeStamp}:undefined;
    inventoryClick=click;
    const source=selectedItem;
    const shouldTransfer=source && ((role==='held' && source.role!=='held' && source.item===item) ||
      ((role==='input' || role==='module') && canPut && source.role==='held' && source.item===item));
    if (shouldTransfer && source) {
      if (click) {
        // A second click turns this into a full-stack transfer from the clicked slot.
        click.singleTransfer=()=>{
          if (selectedItem===source && sameDevice(openInventory(),click.device)) transferSlot(source,slot);
        };
        window.setTimeout(()=>{
          if (inventoryClick!==click) return;
          inventoryClick=undefined;
          click.singleTransfer?.();
        },INVENTORY_DOUBLE_CLICK_MS);
      } else transferSlot(source,slot);
    } else if (canSelectSlot(slot)) {
      selectedItem=sameSlot(selectedItem,slot)?undefined:slot;
    }
    revealInfo(anchor,true);
    refresh();
  }

  return {
    get selection() { return selectedItem; },
    setQuantity(quantity:number) { if (selectedItem) selectedItem.quantity=quantity; },
    select(source:Selection|undefined) { inventoryClick=undefined; selectedItem=source; },
    cancelClick() { inventoryClick=undefined; },
    reset() { inventoryClick=undefined; selectedItem=undefined; pages.clear(); },
    page(key:string) { return pages.get(key) ?? 0; },
    setPage(key:string,page:number) { pages.set(key,page); },
    backpackStackCount,availableInSlot,activateSlot,transferSlot,transferToContainer,takeCargo,
  };
}
