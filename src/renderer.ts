import { FIRST_GAP, Field, H, Kind, Meta, STEP, W, at, cell, xy, type Mode, type PreviewCell } from './model';

type Color = [number,number,number,number];
const rgba = (r:number,g:number,b:number,a=1):Color => [r/255,g/255,b/255,a];
const ink = rgba(12,21,29), frame = rgba(59,84,95), line = rgba(39,60,68), amber = rgba(255,193,109);
const cyan = rgba(119,225,213), red = rgba(255,145,117), grey = rgba(131,157,168);
const mineral = [ink,rgba(180,135,112),rgba(133,169,217),rgba(228,157,86),rgba(194,205,207),rgba(167,184,249),rgba(125,222,209),amber,rgba(221,199,152)];
const shapeForItem = [0,0,3,4,0,3,1,4,1];

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
  toScreen(x:number,y:number) { return [(x-this.x)*this.zoom+this.width/2,(y-this.y)*this.zoom+this.height/2]; }
  toWorld(x:number,y:number) { return [this.x+(x-this.width/2)/this.zoom,this.y+(y-this.height/2)/this.zoom]; }
  pan(dx:number,dy:number) { this.x-=dx/this.zoom; this.y-=dy/this.zoom; this.limit(); }
  scale(atX:number,atY:number,factor:number) {
    const [x,y] = this.toWorld(atX,atY);
    this.zoom=Math.max(7,Math.min(64,this.zoom*factor));
    const [nextX,nextY]=this.toWorld(atX,atY);
    this.x+=x-nextX; this.y+=y-nextY; this.limit();
  }
  focus(tile:number) { const [x,y]=xy(tile); this.x=x+.5; this.y=y+.5; }
  private limit() { this.x=Math.max(0,Math.min(W,this.x)); this.y=Math.max(0,Math.min(H,this.y)); }
}

type Scene = { data:Int32Array; mode:Mode; preview:PreviewCell[]; selected:number; focus:number; trace:number[]; now:number; snapshotAt:number; speed:number; };

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
    if (first) {
      this.camera.zoom=this.small ? Math.max(13,Math.min(24,w/24)) : Math.max(18,Math.min(34,w/36));
      if (this.small) { this.camera.x=13; this.camera.y=16.2; }
    }
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

  private machine(kind:number,x:number,y:number,direction:number,status:number) {
    const B=(dx:number,dy:number,w:number,h:number,color:Color,shape=0,angle=0)=>this.box(x+dx,y+dy,w,h,color,shape,angle);
    let mark=grey;
    if ([Kind.Generator,Kind.Battery,Kind.Solar].includes(kind)) mark=cyan;
    if (kind===Kind.Station || kind===Kind.Assembler) mark=amber;
    if (kind===Kind.Grinder || kind===Kind.Kiln) mark=mineral[5];
    if (kind>=Kind.IronDrill && kind<=Kind.FuelDrill) mark=mineral[kind-1];
    B(.025,.065,.94,.91,rgba(4,10,14,.85),1);
    B(0,0,.92,.91,mark,1);
    B(0,0,.84,.83,rgba(24,41,50),1);
    B(0,-.34,.67,.045,rgba(200,230,231,.16));
    switch (kind) {
      case Kind.Station:
        B(0,0,.63,.63,rgba(112,91,58),2); B(0,0,.53,.53,ink,2);
        B(0,0,.37,.37,mark,2); B(.02,-.015,.27,.27,ink,2);
        B(.07,-.05,.39,.045,mark,0,-.74); B(.16,-.12,.08,.08,mark,2); break;
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
      case Kind.KitPress:
      case Kind.Depot: B(0,0,.62,.55,mark,4); B(0,0,.46,.40,ink,4); B(0,0,.23,.21,mark,4); break;
      case Kind.Smelter:
        B(0,.19,.57,.1,mark,1); B(0,-.19,.57,.1,mark,1); B(0,0,.19,.31,mark,1); break;
      default:
        B(-.12,0,.24,.42,mark,1); B(.15,-.06,.22,.37,mark,0,-.3); B(.25,.22,.13,.09,mark); break;
    }
    if (![Kind.Generator,Kind.Solar,Kind.Battery,Kind.Station].includes(kind)) {
      const [dx,dy]=STEP[direction];
      B(dx*.4,dy*.4,.18,.15,mark,5,direction*Math.PI/2);
    }
    if (status===1) B(-.29,-.29,.10,.10,cyan,2);
    if (status===3) B(.33,-.34,.21,.21,red,3);
    if (status===4) B(.33,-.34,.17,.15,amber,0);
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
    const left=Math.max(0,Math.floor(lx)-1), top=Math.max(0,Math.floor(ty)-1);
    const right=Math.min(W,Math.ceil(rx)+1), bottom=Math.min(H,Math.ceil(by)+1);
    this.length=0;
    const sun=data[Meta.Sun], orbit=mode==='orbit';
    this.box(W/2,H/2,W,H,rgba(14,26,35));
    if (sun || orbit) {
      const x=sun ? 39+Math.sin(data[Meta.Tick]/95)*4 : 45;
      for (let i=10;i>=0;i--) this.box(x,16,6+i*.7,60,rgba(250,173,75,sun?.019:.01),0,.37);
    }
    for (let x=left;x<=right;x++) this.stroke(x,top,x,bottom,x%5===0?.044:.025,x%5===0?frame:line);
    for (let y=top;y<=bottom;y++) this.stroke(left,y,right,y,y%5===0?.044:.025,y%5===0?frame:line);
    for (let i=0;i<25;i++) {
      const x=(i*107%499)/10+2.4,y=(i*41%311)/10+1.2;
      this.box(x,y,1.4+i%3*.5,.6,rgba(91,126,133,.12),3,i%2*.54);
    }
    this.drawCity(Boolean(data[Meta.FirstLight]),Boolean(sun),orbit);

    for (let y=top;y<bottom;y++) for (let x=left;x<right;x++) {
      const tile=y*W+x, kind=cell(data,tile,Field.Kind), ore=cell(data,tile,Field.Ore);
      const dir=cell(data,tile,Field.Direction);
      const [dx,dy]=STEP[dir];
      if (ore) {
        const color=mineral[ore];
        this.box(x+.5,y+.5,1.42,1.35,[color[0],color[1],color[2],.20],4,-.25);
        this.box(x+.18,y+.19,.18,.20,color,kind?2:3);
        if (!kind) this.box(x+.55,y+.55,.31,.25,color,shapeForItem[ore]);
        if (!kind) this.box(x+.79,y+.34,.18,.20,color,shapeForItem[ore]);
      }
      if (kind===Kind.Belt || kind===Kind.Splitter) {
        this.box(x+.5,y+.5,.97,.74,frame,1,dir*Math.PI/2);
        this.box(x+.5,y+.5,.97,.56,rgba(28,46,55),1,dir*Math.PI/2);
        if (kind===Kind.Splitter) {
          const [sx,sy]=STEP[(dir+1)%4];
          this.stroke(x+.5,y+.5,x+.5+sx*.49,y+.5+sy*.49,.33,frame);
          this.box(x+.5+sx*.32,y+.5+sy*.32,.20,.21,grey,5,(dir+1)*Math.PI/2);
        }
        if (c.zoom>=12 || x%3===0 || y%3===0) this.box(x+.5+dx*.20,y+.5+dy*.20,.22,.31,grey,5,dir*Math.PI/2);
      } else if (kind) {
        this.machine(kind,x+.5,y+.5,dir,cell(data,tile,Field.Status));
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
    if (c.zoom>=15 && mode!=='power') {
      const phase=(data[Meta.Tick]%5+Math.min(2,(scene.now-scene.snapshotAt)*scene.speed/50))/5;
      for (let y=top;y<bottom;y++) for (let x=left;x<right;x++) {
        const tile=y*W+x, cargo=cell(data,tile,Field.Cargo);
        if (!cargo) continue;
        const [dx,dy]=STEP[cell(data,tile,Field.Direction)];
        const next=at(x+dx,y+dy);
        const move=next>=0 && cell(data,next,Field.Kind)===Kind.Belt && !cell(data,next,Field.Cargo) ? Math.min(.34,phase*.32) : 0;
        this.box(x+.47+dx*move,y+.47+dy*move,.30,.28,mineral[cargo],shapeForItem[cargo]);
      }
    }

    if (focus>=0) this.marker(focus,rgba(255,173,111,.82),1.22);
    for (const tile of scene.trace) {
      const [x,y]=xy(tile);
      if (x<left || x>=right || y<top || y>=bottom) continue;
      const [dx,dy]=STEP[cell(data,tile,Field.Direction)];
      this.box(x+.5-dy*.42,y+.5+dx*.42,.87,.07,cyan,0,cell(data,tile,Field.Direction)*Math.PI/2);
    }
    if (selected>=0) this.marker(selected,cyan,1.06);
    if (data[Meta.Delivered]===0 && cell(data,FIRST_GAP,Field.Kind)===0) this.marker(FIRST_GAP,amber,1.07);
    for (const part of preview) {
      if (part.tile<0) continue;
      const [x,y]=xy(part.tile), color=part.conflict?red:amber;
      this.box(x+.5,y+.5,.95,.95,[...color.slice(0,3),.24] as Color,1);
      if (part.kind===Kind.Belt) this.box(x+.5,y+.5,.42,.53,color,5,part.dir*Math.PI/2);
      else if (part.kind>0) this.machine(part.kind,x+.5,y+.5,part.dir,0);
      if (part.wire) this.box(x+.5,y+.5,.32,.32,color,3);
      this.marker(part.tile,color,.9);
    }

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program); gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
    gl.uniform2f(this.center,c.x,c.y); gl.uniform2f(this.viewport,c.width,c.height); gl.uniform1f(this.zoom,c.zoom);
    gl.bufferData(gl.ARRAY_BUFFER,this.values.subarray(0,this.length),gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP,0,4,this.length/10);
  }

  private marker(tile:number,color:Color,size:number) {
    const [x,y]=xy(tile);
    for (const i of [-1,1]) for (const j of [-1,1]) {
      this.box(x+.5+i*size*.37,y+.5+j*size/2,.26*size,.065,color);
      this.box(x+.5+i*size/2,y+.5+j*size*.37,.065,.26*size,color);
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
