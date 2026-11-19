import { CityField, Field, H, Kind, Meta, Stage, STEP, W, at, cell, cityValue, inBounds, isTransport, legacyRecipes, xy, type MapLimits, type Mode, type PreviewCell } from './model';
import { cargoIndex, design, transportPorts } from './sim-data';
import { machineAnchor, machinePortTiles, machineSize, previewPorts } from './machine-layout';

type Color = [number,number,number,number];
const rgba = (r:number,g:number,b:number,a=1):Color => [r/255,g/255,b/255,a];
const ink = rgba(12,21,29), frame = rgba(59,84,95), line = rgba(39,60,68), amber = rgba(255,193,109);
const cyan = rgba(119,225,213), red = rgba(255,145,117), grey = rgba(131,157,168);
const mineral = [ink,rgba(180,135,112),rgba(133,169,217),rgba(228,157,86),rgba(194,205,207),rgba(167,184,249),rgba(125,222,209),amber,rgba(221,199,152),
  cyan,rgba(190,111,71),grey,rgba(230,145,83),rgba(145,179,231),rgba(165,175,186),
  rgba(240,158,94),rgba(157,216,252),rgba(205,196,159),rgba(222,165,110),rgba(137,193,204)];
const shapeForItem = [0,0,3,4,0,3,1,4,1,1,3,1,1,1,2,2,3,0,4,1];

const vertex = `#version 300 es
layout(location=0) in vec2 corner;
layout(location=1) in vec4 bounds;
layout(location=2) in vec4 color;
layout(location=3) in vec2 shape;
uniform vec2 camera;
uniform vec2 viewport;
uniform float zoom;
out vec2 uv;
out vec4 tint;
flat out int geometry;
void main(){
  float c=cos(shape.y), s=sin(shape.y);
  vec2 world=bounds.xy+mat2(c,s,-s,c)*(bounds.zw*corner);
  vec2 screen=(world-camera)*zoom*2.0/viewport;
  gl_Position=vec4(screen.x,-screen.y,0.0,1.0);
  uv=corner*2.0;
  tint=color;
  geometry=int(shape.x);
}`;
const fragment = `#version 300 es
precision highp float;
precision highp int;
in vec2 uv;
in vec4 tint;
flat in int geometry;
out vec4 pixel;
void main(){
  vec2 q=abs(uv);
  float d=max(q.x,q.y)-1.0;
  if(geometry==1) d=max(length(max(q-0.70,0.0))-0.30,d);
  if(geometry==2) d=length(uv)-1.0;
  if(geometry==3) d=q.x+q.y-1.0;
  if(geometry==4) d=max(q.x*0.55+q.y,q.x)-0.95;
  if(geometry==5) d=max(abs(uv.y)*1.0+uv.x*0.53-0.53,-uv.x-0.74);
  float a=1.0-smoothstep(-max(fwidth(d),0.015),0.0,d);
  pixel=vec4(tint.rgb,tint.a*a);
}`;

export class Camera {
  x=19.7; y=17.2; zoom=26; width=1; height=1;
  bounds:MapLimits={left:0,top:0,right:W,bottom:H,minZoom:9,maxZoom:48};
  toScreen(x:number,y:number) { return [(x-this.x)*this.zoom+this.width/2,(y-this.y)*this.zoom+this.height/2]; }
  toWorld(x:number,y:number) { return [this.x+(x-this.width/2)/this.zoom,this.y+(y-this.height/2)/this.zoom]; }
  pan(dx:number,dy:number) { this.x-=dx/this.zoom; this.y-=dy/this.zoom; this.limit(); }
  scale(atX:number,atY:number,factor:number) {
    const [x,y] = this.toWorld(atX,atY);
    this.zoom=Math.max(this.bounds.minZoom,Math.min(this.bounds.maxZoom,this.zoom*factor));
    const [nextX,nextY]=this.toWorld(atX,atY);
    this.x+=x-nextX; this.y+=y-nextY; this.limit();
  }
  focus(tile:number) { const [x,y]=xy(tile); this.aim(x+.5,y+.5); }
  aim(x:number,y:number,zoom=this.zoom) {
    this.x=x; this.y=y;
    this.zoom=Math.max(this.bounds.minZoom,Math.min(this.bounds.maxZoom,zoom));
    this.limit();
  }
  tileAt(px:number,py:number) {
    const [x,y]=this.toWorld(px,py);
    return inBounds(this.bounds,x,y)?at(Math.floor(x),Math.floor(y)):-1;
  }
  private limit() {
    const {left,right,top,bottom}=this.bounds;
    const halfX=Math.min((right-left)/2,this.width/this.zoom/2);
    const halfY=Math.min((bottom-top)/2,this.height/this.zoom/2);
    this.x=Math.max(left+halfX,Math.min(right-halfX,this.x));
    this.y=Math.max(top+halfY,Math.min(bottom-halfY,this.y));
  }
}

type Scene = { data:Int32Array; mode:Mode; preview:PreviewCell[]; selected:number; focus:number; trace:[number,number][]; now:number; tick:number; chipTile:number; chip:number; };

export class Renderer {
  readonly camera = new Camera();
  private gl:WebGL2RenderingContext;
  private program!:WebGLProgram;
  private buffer!:WebGLBuffer;
  private vao!:WebGLVertexArrayObject;
  private viewport!:WebGLUniformLocation;
  private center!:WebGLUniformLocation;
  private zoom!:WebGLUniformLocation;
  private values = new Float32Array(60_000);
  private length = 0;
  private dirty = true;
  private available = true;
  private ratio = 1.5;
  private qualityTime = 0;
  private qualityFrames = 0;
  private lastFrame = 0;
  private small = false;
  private drawn = new Uint8Array(W*H);

  constructor(readonly canvas:HTMLCanvasElement) {
    const context = canvas.getContext('webgl2',{alpha:false,antialias:false,depth:false,preserveDrawingBuffer:false,powerPreference:'high-performance'});
    if (!context) throw new Error('当前浏览器无法启用 WebGL 2。');
    this.gl=context;
    this.setup();
    this.resize(true);
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('webglcontextlost',event => { event.preventDefault(); this.available=false; });
    canvas.addEventListener('webglcontextrestored',() => { this.setup(); this.available=true; this.dirty=true; });
  }

  private setup() {
    const gl=this.gl;
    const compile=(stage:number,source:string)=>{
      const shader=gl.createShader(stage)!;
      gl.shaderSource(shader,source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? '绘图着色器编译失败');
      return shader;
    };
    const vs=compile(gl.VERTEX_SHADER,vertex), fs=compile(gl.FRAGMENT_SHADER,fragment);
    this.program=gl.createProgram()!;
    gl.attachShader(this.program,vs); gl.attachShader(this.program,fs); gl.linkProgram(this.program);
    gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(this.program,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.program) ?? '绘图链接失败');
    this.center=gl.getUniformLocation(this.program,'camera')!;
    this.viewport=gl.getUniformLocation(this.program,'viewport')!;
    this.zoom=gl.getUniformLocation(this.program,'zoom')!;
    this.vao=gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const quad=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,quad);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-.5,-.5,.5,-.5,-.5,.5,.5,.5]),gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
    this.buffer=gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
    for (const [slot,count,offset] of [[1,4,0],[2,4,16],[3,2,32]]) {
      gl.enableVertexAttribArray(slot); gl.vertexAttribPointer(slot,count,gl.FLOAT,false,40,offset); gl.vertexAttribDivisor(slot,1);
    }
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(...ink);
  }

  private resize(first=false) {
    const {clientWidth:w,clientHeight:h}=this.canvas;
    if (!w || !h) return;
    this.camera.width=w; this.camera.height=h;
    this.small=matchMedia('(pointer: coarse)').matches || w<580;
    const cam=this.camera;
    const initial=this.small?Math.max(13,Math.min(24,w/24)):Math.max(18,Math.min(34,w/36));
    cam.aim(cam.x,cam.y,first?initial:cam.zoom);
    this.dirty=true;
  }

  private box(x:number,y:number,w:number,h:number,color:Color,shape=0,angle=0) {
    if (this.length+10>this.values.length) {
      const larger=new Float32Array(this.values.length*2); larger.set(this.values); this.values=larger;
    }
    const dst=this.values, i=this.length;
    dst[i]=x; dst[i+1]=y; dst[i+2]=w; dst[i+3]=h;
    dst[i+4]=color[0]; dst[i+5]=color[1]; dst[i+6]=color[2]; dst[i+7]=color[3];
    dst[i+8]=shape; dst[i+9]=angle; this.length+=10;
  }

  private stroke(x:number,y:number,ex:number,ey:number,weight:number,color:Color) {
    const dx=ex-x,dy=ey-y;
    this.box((x+ex)/2,(y+ey)/2,Math.hypot(dx,dy),weight,color,0,Math.atan2(dy,dx));
  }

  private machine(kind:number,x:number,y:number,status:number,opacity=1) {
    const B=(dx:number,dy:number,w:number,h:number,color:Color,shape=0,angle=0)=>
      this.box(x+dx,y+dy,w,h,opacity===1?color:[color[0],color[1],color[2],color[3]*opacity],shape,angle);
    let mark=grey;
    if ([Kind.Generator,Kind.Battery,Kind.Solar].includes(kind)) mark=cyan;
    if (kind===Kind.Station || kind===Kind.Assembler || kind===Kind.Splicer) mark=amber;
    if (kind===Kind.Grinder || kind===Kind.Kiln) mark=mineral[5];
    if (kind>=Kind.IronDrill && kind<=Kind.FuelDrill) mark=mineral[kind-1];
    if (kind===Kind.CopperDrill || kind===Kind.ReinforcedCopperDrill) mark=mineral[10];
    B(.025,.065,.94,.91,rgba(4,10,14,.85),1);
    B(0,0,.92,.91,mark,1);
    B(0,0,.84,.83,rgba(24,41,50),1);
    B(0,-.34,.67,.045,rgba(200,230,231,.16));
    switch (kind) {
      case Kind.Station:
        B(0,0,.63,.63,rgba(112,91,58),2); B(0,0,.53,.53,ink,2);
        B(0,0,.37,.37,mark,2); B(.02,-.015,.27,.27,ink,2);
        B(.07,-.05,.39,.045,mark,0,-.74); B(.16,-.12,.08,.08,mark,2); break;
      case Kind.DevelopmentHub:
        B(0,0,.67,.67,mark,2); B(0,0,.52,.52,ink,2);
        B(0,0,.20,.42,amber,1); B(0,-.14,.29,.23,amber,5,-Math.PI/2); break;
      case Kind.Generator:
        B(0,0,.58,.58,mark,2); B(0,0,.48,.48,ink,2);
        B(.025,-.025,.32,.13,mark,5,-1.05); B(-.035,.08,.27,.13,mark,5,Math.PI-1.05); break;
      case Kind.Battery:
      case Kind.Solar:
        for (let n=-1;n<=1;n++) {
          B(n*.17,0,.13,.48,mark,1);
          if (kind===Kind.Solar) B(n*.17,0,.09,.40,rgba(22,53,61));
        }
        if (kind===Kind.Solar) B(0,0,.49,.035,mark); break;
      case Kind.Grinder:
      case Kind.Kiln: B(0,0,.6,.6,mark,3); B(0,0,.42,.42,ink,3); B(0,0,.25,.25,mark,3); break;
      case Kind.Calibrator: B(0,0,.54,.15,cyan,1); B(0,0,.15,.54,cyan,1); break;
      case Kind.Assembler:
      case Kind.Splicer:
      case Kind.KitPress:
      case Kind.Depot: B(0,0,.62,.55,mark,4); B(0,0,.46,.40,ink,4); B(0,0,.23,.21,mark,4); break;
      case Kind.Yard:
        B(0,.12,.73,.13,grey); B(-.2,-.07,.24,.24,amber,1); B(.12,-.07,.24,.24,amber,1); break;
      case Kind.Bench: case Kind.Smelter:
        B(0,.19,.57,.1,mark,1); B(0,-.19,.57,.1,mark,1); B(0,0,.19,.31,mark,1); break;
      case Kind.ReinforcedIronDrill: case Kind.ReinforcedSilicaDrill: case Kind.ReinforcedFuelDrill: case Kind.ReinforcedCopperDrill:
        B(0,0,.64,.57,mark,1); B(0,0,.54,.47,ink,1);
        B(-.12,0,.18,.40,mark,1); B(.11,0,.20,.33,mark,1); B(.25,-.25,.13,.13,amber,3); break;
      default:
        B(-.12,0,.24,.42,mark,1); B(.15,-.06,.22,.37,mark,0,-.3); B(.25,.22,.13,.09,mark); break;
    }
    if (status===1) B(-.29,-.29,.10,.10,cyan,2);
    if (status===3) B(.33,-.34,.21,.21,red,3);
    if (status===4) B(.33,-.34,.17,.15,amber,0);
  }

  private machineBody(kind:number,x:number,y:number,dir:number,status:number,opacity=1) {
    const [width,height]=machineSize(kind,dir);
    const cx=x+width/2, cy=y+height/2;
    if (width>1 || height>1) {
      this.box(cx,cy,width-.07,height-.07,rgba(104,145,152,opacity),1);
      this.box(cx,cy,width-.16,height-.16,rgba(24,41,50,opacity),1);
    }
    this.machine(kind,cx,cy,status,opacity);
  }

  private materialPort(x:number,y:number,side:number,output:boolean,paired=false) {
    const [dx,dy]=STEP[side];
    const offset=paired?(output ? .11 : -.11):0;
    const px=x+.5+dx*.44-dy*offset, py=y+.5+dy*.44+dx*offset;
    this.box(px,py,.30,.24,ink,1,side*Math.PI/2);
    this.box(px,py,.20,.17,output?amber:cyan,5,(side+(output?0:2))*Math.PI/2);
  }

  private transport(kind:number,x:number,y:number,dir:number,detail:boolean,preview?:Color) {
    const tier=design(kind)?.beltTier ?? 0;
    const style=preview ?? (tier===3?amber:tier===2?cyan:frame);
    const lanes=design(kind)?.lanes ?? 1;
    for (let lane=lanes-1;lane>=0;lane--) {
      const angle=(dir+lane)%4*Math.PI/2;
      const width=lanes===2?.46:.72;
      this.box(x,y,.98,width,style,1,angle);
      this.box(x,y,.97,width-.12,rgba(24,43,53),1,angle);
      if (lanes===2 && lane===0) this.box(x,y,.42,width+.02,style,1,angle);
    }
    for (let lane=0;lane<lanes;lane++) {
      const {incoming,outgoing}=transportPorts(kind,dir,lane);
      if (kind===Kind.Merger || kind===Kind.Splitter) {
        const ports=kind===Kind.Merger?incoming:outgoing;
        const reach=kind===Kind.Merger?-.42:.42;
        for (let flow=0;flow<4;flow++) {
          if (!(ports&(1<<flow))) continue;
          const [dx,dy]=STEP[flow];
          this.stroke(x,y,x+dx*reach,y+dy*reach,.065,style);
        }
        this.box(x,y,.19,.19,style,kind===Kind.Merger?2:3);
      }
      for (let flow=0;flow<4;flow++) {
        const [dx,dy]=STEP[flow];
        const direction=flow*Math.PI/2;
        if (outgoing&(1<<flow)) {
          const dist=tier>1?.29:.33;
          this.box(x+dx*dist,y+dy*dist,.22,.20,preview ?? grey,5,direction);
          if (tier>1) this.box(x+dx*.08,y+dy*.08,.17,.18,style,5,direction);
          if (tier===3) this.box(x-dx*.13,y-dy*.13,.17,.18,style,5,direction);
        }
        if (detail && incoming&(1<<flow)) this.box(x-dx*.42,y-dy*.42,.10,.13,preview ?? style,5,direction);
      }
    }
  }

  private cargoCenter(data:Int32Array,location:number):[number,number] {
    const tile=Math.floor(location/2), [x,y]=xy(tile);
    if (cell(data,tile,Field.Kind)!==Kind.Crossing) return [x+.5,y+.5];
    const [dx,dy]=STEP[(cell(data,tile,Field.Direction)+location%2)%4];
    return [x+.5-dy*.18,y+.5+dx*.18];
  }

  render(scene:Scene) {
    if (!this.available) return;
    const gl=this.gl, c=this.camera;
    if (this.small && this.lastFrame && scene.now-this.lastFrame<30) return;
    if (this.small && this.lastFrame) {
      this.qualityTime+=Math.min(scene.now-this.lastFrame,100); this.qualityFrames++;
      if (this.qualityFrames>=70) {
        if (this.qualityTime/this.qualityFrames>44 && this.ratio>1) { this.ratio-=.25; this.dirty=true; }
        this.qualityTime=0; this.qualityFrames=0;
      }
    }
    this.lastFrame=scene.now;
    if (this.dirty) {
      const ratio=Math.min(devicePixelRatio,this.small?this.ratio:2);
      this.canvas.width=Math.max(1,Math.round(c.width*ratio)); this.canvas.height=Math.max(1,Math.round(c.height*ratio));
      gl.viewport(0,0,this.canvas.width,this.canvas.height); this.dirty=false;
    }
    const {data,mode,preview,selected,focus}=scene;
    const [lx,ty]=c.toWorld(0,0), [rx,by]=c.toWorld(c.width,c.height);
    const bounds=c.bounds;
    const left=Math.max(bounds.left,Math.floor(lx)-1), top=Math.max(bounds.top,Math.floor(ty)-1);
    const right=Math.min(bounds.right,Math.ceil(rx)+1), bottom=Math.min(bounds.bottom,Math.ceil(by)+1);
    this.length=0;
    const sun=data[Meta.Sun], orbit=mode==='orbit';
    this.box((bounds.left+bounds.right)/2,(bounds.top+bounds.bottom)/2,bounds.right-bounds.left,bounds.bottom-bounds.top,rgba(14,26,35));
    if (sun || orbit) {
      const x=sun ? data[Meta.BeamX100]/100 : 45;
      for (let i=10;i>=0;i--) this.box(x,16,3+i*.6,60,rgba(250,173,75,sun?.026:.01));
    }
    for (let x=left;x<=right;x++) this.stroke(x,top,x,bottom,x%5===0?.044:.025,
      x===bounds.left || x===bounds.right?grey:x%5===0?frame:line);
    for (let y=top;y<=bottom;y++) this.stroke(left,y,right,y,y%5===0?.044:.025,
      y===bounds.top || y===bounds.bottom?grey:y%5===0?frame:line);
    for (let i=0;i<25;i++) {
      const x=(i*107%499)/10+2.4,y=(i*41%311)/10+1.2;
      if (inBounds(bounds,x,y)) this.box(x,y,1.4+i%3*.5,.6,rgba(91,126,133,.12),3,i%2*.54);
    }
    if (data[Meta.Stage]>=Stage.Launch) this.drawCity(Boolean(data[Meta.FirstLight]),Boolean(sun),orbit);
    const finale=data[Meta.VictoryTicks];
    if (data[Meta.Stage]>=Stage.Valley) for (const city of [1,2]) {
      if (city===2 && data[Meta.Stage]<Stage.Highland) break;
      const site=cityValue(data,city,CityField.Site), [x,y]=xy(site), lit=(data[Meta.LitMask] & (1<<city))!==0;
      const litNow=lit && (finale<0 || finale>city*30);
      this.box(x+.5,y-4,6.3,4.9,rgba(30,45,52),4);
      for (let row=0;row<3;row++) for (let col=0;col<4;col++) {
        const bx=x-1.4+col*1.2,by=y-5.3+row*1.15;
        this.box(bx,by,.87,.73,frame,1); this.box(bx,by,.46,.18,litNow?amber:grey,1);
      }
      const send=cityValue(data,city,CityField.Sender), receive=cityValue(data,city,CityField.Receiver);
      if (cell(data,send,Field.Kind)!==Kind.Yard) continue;
      const [sx,sy]=xy(send),[ex,ey]=xy(receive);
      if (orbit || focus===send || focus===receive) {
        for(let n=0;n<24;n+=2) this.stroke(sx+.5+(ex-sx)*n/24,sy+.5+(ey-sy)*n/24,sx+.5+(ex-sx)*(n+1)/24,sy+.5+(ey-sy)*(n+1)/24,.06,grey);
      }
      const eta=cityValue(data,city,CityField.Arrival);
      if (eta>=0) {
        const t=1-eta/data[Meta.Travel]; this.box(sx+.5+(ex-sx)*t,sy+.5+(ey-sy)*t,.55,.4,amber,1);
      }
    }

    this.drawn.fill(0);
    for (let y=top;y<bottom;y++) for (let x=left;x<right;x++) {
      const tile=y*W+x, anchor=machineAnchor(data,tile);
      const kind=anchor<0?0:cell(data,anchor,Field.Kind), ore=cell(data,tile,Field.Ore);
      const dir=cell(data,tile,Field.Direction);
      if (ore && (anchor<0 || anchor===tile)) {
        const color=mineral[ore];
        this.box(x+.5,y+.5,1.42,1.35,[color[0],color[1],color[2],.20],4,-.25);
        this.box(x+.18,y+.19,.18,.20,color,kind?2:3);
        if (!kind) this.box(x+.55,y+.55,.31,.25,color,shapeForItem[ore]);
        if (!kind) this.box(x+.79,y+.34,.18,.20,color,shapeForItem[ore]);
        if (tile===data[Meta.FirstOre] && !kind) {
          for (const [ox,oy,size] of [[.23,.58,.34],[.46,.37,.43],[.65,.56,.36],[.78,.42,.24]]) {
            this.box(x+ox,y+oy,size,size*.86,rgba(124,86,67),4,-.25);
            this.box(x+ox-.03,y+oy-.05,size*.74,size*.48,rgba(224,173,132),3,-.24);
          }
        }
        if (tile===scene.chipTile && scene.chip>0) {
          const drift=1-scene.chip;
          this.box(x+.5+drift*.5,y+.3-Math.sin(drift*Math.PI)*.48,.16,.14,color,3,drift*2);
        }
      }
      if (isTransport(kind)) {
        this.transport(kind,x+.5,y+.5,dir,c.zoom>=12);
      } else if (anchor>=0 && !this.drawn[anchor]) {
        this.drawn[anchor]=1;
        const [ax,ay]=xy(anchor);
        this.machineBody(kind,ax,ay,cell(data,anchor,Field.Direction),cell(data,anchor,Field.Status));
        if (kind===Kind.SimpleMiner) {
          const progress=cell(data,anchor,Field.Progress)/data[Meta.MinerTicks];
          const stroke=Math.sin(progress*Math.PI*4)*.08;
          this.box(ax+.45,ay+.47+stroke,.16,.38,amber,4);
          this.box(ax+.82,ay+.82,.38,.24,frame,1);
          if (cell(data,anchor,Field.Inventory)>0) this.box(ax+.82,ay+.79,.22,.18,mineral[1],4);
          if (progress>.78) this.box(ax+.53+(progress-.78)*1.2,ay+.52+(progress-.78),.13,.13,mineral[1],4);
        }
      }
    }
    for (const [tile,anchor,masks] of machinePortTiles(data)) {
      if (c.zoom<16 && anchor!==selected) continue;
      const [x,y]=xy(tile);
      if (x<left || x>=right || y<top || y>=bottom) continue;
      for (let side=0;side<4;side++) {
        const input=Boolean(masks & (1<<((side+2)%4))), output=Boolean(masks & (16<<side));
        if (input) this.materialPort(x,y,side,false,output);
        if (output) this.materialPort(x,y,side,true,input);
      }
    }

    const showPower=mode==='power' || preview.some(part=>part.wire);
    if (showPower) for (let y=top;y<bottom;y++) for (let x=left;x<right;x++) {
      const tile=y*W+x;
      if (!cell(data,tile,Field.Wire)) continue;
      const group=cell(data,tile,Field.Grid);
      const selectedGrid=selected>=0?cell(data,selected,Field.Grid):data[Meta.StationGrid];
      const color=group===selectedGrid?cyan:rgba(80,138,153,.70);
      this.box(x+.5,y+.5,.14,.14,color,3);
      for (const [nx,ny] of [[x+1,y],[x,y+1]]) {
        const next=at(nx,ny);
        if (next<0 || !cell(data,next,Field.Wire)) continue;
        const dx=nx-x,dy=ny-y;
        this.stroke(x+.5+dx*.14,y+.5+dy*.14,x+.5+dx*.45,y+.5+dy*.45,.067,color);
        this.stroke(x+.5+dx*.59,y+.5+dy*.59,x+.5+dx*.88,y+.5+dy*.88,.067,color);
      }
    }
    if (c.zoom>=9) {
      const tracks=cargoIndex(data);
      const size=Math.max(.30,3/c.zoom);
      for (let y=top;y<bottom;y++) for (let x=left;x<right;x++) {
        const tile=y*W+x;
        for (let lane=1;lane>=0;lane--) {
          const loc=tile*2+lane, row=tracks.get(loc);
          if (row===undefined) continue;
          const item=data[row+2], from=data[row+4], since=data[row+5], until=data[row+6];
          const [tx,ty]=this.cargoCenter(data,loc);
          const [fx,fy]=this.cargoCenter(data,from);
          const phase=data[row+7]?1:Math.max(0,Math.min(1,(scene.tick-since)/Math.max(1,until-since)));
          const px=fx+(tx-fx)*phase, py=fy+(ty-fy)*phase;
          this.box(px,py,size+.08,size+.08,ink,shapeForItem[item]);
          this.box(px,py,size,size,mineral[item],shapeForItem[item]);
        }
      }
    }

    if (focus>=0) this.marker(focus,rgba(255,173,111,.82),1.22);
    for (const [tile,flow] of scene.trace) {
      const [x,y]=xy(tile);
      if (x<left || x>=right || y<top || y>=bottom) continue;
      const [dx,dy]=STEP[flow];
      this.box(x+.5-dy*.42,y+.5+dx*.42,.87,.07,cyan,0,flow*Math.PI/2);
    }
    if (selected>=0) this.marker(selected,cyan,1.06,...machineSize(cell(data,selected,Field.Kind),cell(data,selected,Field.Direction)));
    for (const part of preview) {
      if (part.tile<0) continue;
      const [x,y]=xy(part.tile), color=part.conflict?red:amber;
      const [width,height]=machineSize(part.kind,part.dir);
      this.box(x+width/2,y+height/2,width-.05,height-.05,[...color.slice(0,3),.24] as Color,1);
      if (isTransport(part.kind)) this.transport(part.kind,x+.5,y+.5,part.dir,true,color);
      else if (part.kind>0) {
        this.machineBody(part.kind,x,y,part.dir,0,.68);
        const ports=[...previewPorts(part.tile,part.kind,part.dir,legacyRecipes(data))];
        for (const port of ports) {
          const [px,py]=xy(port.tile);
          this.materialPort(px,py,port.side,port.role==='output',
            ports.some(peer=>peer.tile===port.tile && peer.side===port.side && peer.role!==port.role));
        }
      }
      if (part.wire) this.box(x+.5,y+.5,.32,.32,color,3);
      this.marker(part.tile,color,.9,width,height);
    }

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program); gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
    gl.uniform2f(this.center,c.x,c.y); gl.uniform2f(this.viewport,c.width,c.height); gl.uniform1f(this.zoom,c.zoom);
    gl.bufferData(gl.ARRAY_BUFFER,this.values.subarray(0,this.length),gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP,0,4,this.length/10);
  }

  private marker(tile:number,color:Color,size:number,width=1,height=1) {
    const [x,y]=xy(tile);
    const hw=(width-1+size)/2, hh=(height-1+size)/2;
    for (const i of [-1,1]) for (const j of [-1,1]) {
      this.box(x+width/2+i*(hw-.13*size),y+height/2+j*hh,.26*size,.065,color);
      this.box(x+width/2+i*hw,y+height/2+j*(hh-.13*size),.065,.26*size,color);
    }
  }

  private drawCity(lit:boolean,beam:boolean,orbit:boolean) {
    const base=lit?rgba(98,89,66,.54):rgba(64,85,94,.64);
    this.box(43.9,8.8,12.4,7.8,rgba(36,50,56,.77),4);
    this.box(43.9,8.8,11.9,7.4,rgba(18,34,39,.92),4);
    for (let row=0;row<4;row++) {
      const y=6.6+row*1.16;
      this.stroke(39.2,y+.5,49.2,y+.5,.12,base);
      for (let col=0;col<7;col++) {
        const x=39.6+col*1.37+row%2*.22;
        this.box(x,y,.83,.64,base,1);
        for (let light=0;light<3;light++) {
          const color=lit?rgba(255,195,111,beam?.95:.50):rgba(145,169,170,.36);
          this.box(x-.24+light*.24,y,.12,.14,color,1);
        }
      }
    }
    if (orbit) for (let n=0;n<18;n++) {
      const x=28+n*1.47,y=8-Math.sin(n*.19)*5;
      this.box(x,y,.74,.083,rgba(255,193,109,.9),0,-Math.cos(n*.19)*.52);
    }
  }
}
