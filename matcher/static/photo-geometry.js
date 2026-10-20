// The same projective mapping as matcher/geometry.py. Nothing is rasterised while the camera moves.
const PhotoGeometry={
  resolve(recipe={},edits={}){
    const r=recipe||{},view=r.composition?.views?.[edits.composition||'natural']||{},automatic=edits.auto_align!==false,
      degrees=edits.straighten??(automatic&&(r.version??3)>=3?(view.straighten??r.straighten):0),
      skew={...((edits.auto_skew??automatic)&&(r.version||0)>=4?(view.skew??r.skew):{}),...edits.skew};
    return {straighten:Number(degrees)||0,horizontal:skew.horizontal||0,vertical:skew.vertical||0};
  },
  region(value,turn=0,box=[0,0,1,1]){
    let {horizontal:x=0,vertical:y=0}=value;turn=(turn%360+360)%360;
    [x,y]=turn===90?[-y,x]:turn===180?[-x,-y]:turn===270?[y,-x]:[x,y];
    const [left,top,w,h]=box,d=1+x*(left+w/2-.5)+y*(top+h/2-.5);
    return {straighten:value.straighten||0,horizontal:x*w/d,vertical:y*h/d};
  },
  multiply(a,b){return a.map((row,i)=>row.map((_,j)=>row.reduce((sum,v,k)=>sum+v*b[k][j],0)));},
  inverse(a){
    const [[a0,b,c],[d,e,f],[g,h,i]]=a,out=[[e*i-f*h,c*h-b*i,b*f-c*e],[f*g-d*i,a0*i-c*g,c*d-a0*f],[d*h-e*g,b*g-a0*h,a0*e-b*d]],det=a0*out[0][0]+b*out[1][0]+c*out[2][0];
    return out.map(row=>row.map(v=>v/det));
  },
  point(m,[x,y]){const d=m[2][0]*x+m[2][1]*y+m[2][2];return [(m[0][0]*x+m[0][1]*y+m[0][2])/d,(m[1][0]*x+m[1][1]*y+m[1][2])/d];},
  matrix(w,h,value={}){
    const a=(value.straighten||0)*Math.PI/180,c=Math.cos(a),s=Math.sin(a),x=value.horizontal||0,y=value.vertical||0;
    let trim=1;
    for(const [px,py] of [[-.5,-.5],[.5,-.5],[.5,.5],[-.5,.5]]){
      const u=c*px+s*h/w*py,v=-s*w/h*px+c*py,d=Math.max(2*Math.abs(u),2*Math.abs(v))+x*u+y*v;
      if(d>0)trim=Math.min(trim,1/d);
    }
    const mul=this.multiply,rotation=[[c,-s*h/w,0],[s*w/h,c,0],[0,0,1]],project=[[1,0,0],[0,1,0],[x,y,1]],
      shift=[[1,0,.5],[0,1,.5],[0,0,1]],centre=[[1,0,-.5],[0,1,-.5],[0,0,1]];
    return {matrix:mul(mul(mul(mul(shift,[[1/trim,0,0],[0,1/trim,0],[0,0,1]]),rotation),project),centre),trim};
  },
  turn(degrees){return degrees===90?[[0,-1,1],[1,0,0],[0,0,1]]:degrees===180?[[-1,0,1],[0,-1,1],[0,0,1]]:degrees===270?[[0,1,0],[-1,0,1],[0,0,1]]:[[1,0,0],[0,1,0],[0,0,1]];},
  frame(dims,value,turn=0,roi=[0,0,1,1]){
    const [w,h]=turn%180?[dims[1],dims[0]]:dims,width=w*roi[2],height=h*roi[3],result=this.matrix(width,height,this.region(value,turn,roi)),
      crop=[[1/roi[2],0,-roi[0]/roi[2]],[0,1/roi[3],-roi[1]/roi[3]],[0,0,1]];
    return {width,height,trim:result.trim,matrix:this.multiply(this.multiply(result.matrix,crop),this.turn(turn))};
  },
  css(m,w,h){
    const a=this.multiply(this.multiply([[w,0,0],[0,h,0],[0,0,1]],m),[[1/w,0,0],[0,1/h,0],[0,0,1]]);
    return `matrix3d(${[a[0][0],a[1][0],0,a[2][0],a[0][1],a[1][1],0,a[2][1],0,0,1,0,a[0][2],a[1][2],0,a[2][2]].join(',')})`;
  }
};
if(typeof module!=='undefined')module.exports={PhotoGeometry};
