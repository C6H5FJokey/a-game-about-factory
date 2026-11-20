export function advanceRecords(section:string,start:number,end:number,count:number,words:number) {
  const next=start+count*words;
  if (!(count>=0 && start<=next && next<=end)) {
    throw new RangeError(`Invalid ${section} record at word ${start}`);
  }
  return next;
}

export function checkRows(section:string,start:number,end:number,words:number) {
  if (start>end || (end-start)%words!==0) {
    throw new RangeError(`Invalid ${section} row boundary at word ${end}`);
  }
}
