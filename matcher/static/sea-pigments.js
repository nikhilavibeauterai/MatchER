// Colours come from the pictures, never from a synthetic average between unrelated hues. Small palettes keep
// coloured stage lights amongst dark shadows; the local field keeps a distant daylight shot from bleaching them.
const SeaPigments = {
  bins: 76,
  family(r,g,b){
    const hi=Math.max(r,g,b),lo=Math.min(r,g,b),chroma=hi-lo;
    if(chroma<Math.max(12,hi*.16))return 72+Math.min(3,Math.floor((r*.21+g*.72+b*.07)/64));
    const hue=(hi===r?((g-b)/chroma+6)%6:hi===g?(b-r)/chroma+2:(r-g)/chroma+4)/6;
    return Math.min(17,Math.floor(hue*18))*4+Math.min(3,Math.floor(hi/64));
  },
  sample({data,width,height},x0,y0,w,h){
    const bins=new Map(),samples=[];let r=0,g=0,b=0,n=0;
    for(let y=Math.max(0,y0);y<Math.min(height,y0+h);y++)for(let x=Math.max(0,x0);x<Math.min(width,x0+w);x++){
      const i=(y*width+x)*4,a=data[i+3]/255;if(!a)continue;
      const rgb=[data[i],data[i+1],data[i+2]],hi=Math.max(...rgb),lo=Math.min(...rgb),sat=hi?(hi-lo)/hi:0,
        bin=this.family(...rgb),weight=a*(bin>=72?.16:.25+.75*sat)*(.1+.9*Math.min(1,hi/40));
      let cell=bins.get(bin);if(!cell){cell={bin,weight:0,sum:[0,0,0]};bins.set(bin,cell);}
      cell.weight+=weight;for(let j=0;j<3;j++)cell.sum[j]+=rgb[j]*weight;
      samples.push({bin,rgb});r+=rgb[0]*a;g+=rgb[1]*a;b+=rgb[2]*a;n+=a;
    }
    if(!n)return null;
    const leading=[...bins.values()].sort((a,b)=>b.weight-a.weight||a.bin-b.bin).slice(0,3),total=leading.reduce((sum,p)=>sum+p.weight,0);
    for(const cell of leading){
      const mean=cell.sum.map(v=>v/cell.weight);let distance=Infinity;
      // The representative is a pixel that actually occurs in the photo, including its original darkness.
      for(const p of samples)if(p.bin===cell.bin){const d=p.rgb.reduce((s,v,i)=>s+(v-mean[i])**2,0);if(d<distance){distance=d;cell.rgb=p.rgb;}}
    }
    return {mean:[r/n,g/n,b/n],palette:leading.map(p=>({bin:p.bin,rgb:p.rgb,weight:p.weight/total}))};
  },
  merge(parts,limit=4){
    const bins=new Map();
    for(const {palette,weight=1}of parts)for(const p of palette){
      let cell=bins.get(p.bin);if(!cell){cell={bin:p.bin,weight:0,sum:[0,0,0],samples:[]};bins.set(p.bin,cell);}
      const mass=p.weight*weight;cell.weight+=mass;for(let i=0;i<3;i++)cell.sum[i]+=p.rgb[i]*mass;cell.samples.push(p.rgb);
    }
    const leading=[...bins.values()].sort((a,b)=>b.weight-a.weight||a.bin-b.bin).slice(0,limit),total=leading.reduce((sum,p)=>sum+p.weight,0);
    return leading.map(p=>{
      const mean=p.sum.map(v=>v/p.weight);let rgb,distance=Infinity;
      for(const sample of p.samples){const d=sample.reduce((s,v,i)=>s+(v-mean[i])**2,0);if(d<distance||d===distance&&sample.join(',')<rgb.join(',')){distance=d;rgb=sample;}}
      return {bin:p.bin,rgb,weight:p.weight/total};
    });
  },
  // A fixed viewport grid. Nearby colours vote within their overlap; beyond that overlap the nearest photo's
  // colour continues all the way out. There is no paper or neutral background between the colour regions.
  field(spots,W,H,camera,field){
    const scale=Math.max(10,W/128,H/80),w=Math.max(1,Math.ceil(W/scale)),h=Math.max(1,Math.ceil(H/scale)),cells=w*h,
      {zoom,tx,ty}=camera;
    if(!field||field.w!==w||field.h!==h){
      const canvas=field?.canvas||document.createElement('canvas');canvas.width=w;canvas.height=h;
      const ctx=canvas.getContext('2d');field={canvas,ctx,w,h,pixels:ctx.createImageData(w,h),votes:new Float32Array(cells*this.bins*4),nearest:new Int32Array(cells)};
    }else{field.votes.fill(0);field.pixels.data.fill(0);}
    const votes=field.votes,nearest=field.nearest||(field.nearest=new Int32Array(cells)),centres=[];nearest.fill(-1);
    for(const spot of spots){
      // At close zoom, distant off-screen photos must not outvote the one filling the screen.
      const x=(spot.x*zoom+tx)/W*w,y=(spot.y*zoom+ty)/H*h,radius=Math.max(40,Math.min(Math.max(W,H)*.5,spot.size*3.4*zoom)),
        rx=Math.max(1,radius/W*w),ry=Math.max(1,radius/H*h),x0=Math.max(0,Math.floor(x-rx)),x1=Math.min(w-1,Math.ceil(x+rx)),
        y0=Math.max(0,Math.floor(y-ry)),y1=Math.min(h-1,Math.ceil(y+ry));
      const index=centres.length,px=Math.max(0,Math.min(w-1,Math.floor(x))),py=Math.max(0,Math.min(h-1,Math.floor(y))),cell=py*w+px,old=centres[nearest[cell]];
      const rgb=spot.palette[0].rgb,order=rgb[0]*65536+rgb[1]*256+rgb[2],distance=(x-px-.5)**2+(y-py-.5)**2,previous=old?(old.x-px-.5)**2+(old.y-py-.5)**2:Infinity;
      centres.push({x,y,rgb,order});
      if(distance<previous||distance===previous&&order<old.order)nearest[cell]=index;
      for(let py=y0;py<=y1;py++)for(let px=x0;px<=x1;px++){
        const d=((px+.5-x)/rx)**2+((py+.5-y)/ry)**2;if(d>=1)continue;
        const influence=(1-d)**3,cell=(py*w+px)*this.bins*4;
        for(const p of spot.palette){const i=cell+p.bin*4,mass=influence*p.weight;votes[i]+=mass;votes[i+1]+=mass*p.rgb[0];votes[i+2]+=mass*p.rgb[1];votes[i+3]+=mass*p.rgb[2];}
      }
    }
    // Propagate nearest photo seeds across empty water. The two bounded sweeps also handle a camera panned
    // entirely away from the photos, without searching the library for every pixel or leaving blank edges.
    const visit=(x,y,neighbours)=>{
      const cell=y*w+x;let best=nearest[cell],distance=best<0?Infinity:(centres[best].x-x-.5)**2+(centres[best].y-y-.5)**2;
      for(const offset of neighbours){const nx=x+offset[0],ny=y+offset[1];if(nx<0||nx>=w||ny<0||ny>=h)continue;
        const index=nearest[ny*w+nx];if(index<0)continue;const p=centres[index],d=(p.x-x-.5)**2+(p.y-y-.5)**2;
        if(d<distance||d===distance&&p.order<centres[best].order){distance=d;best=index;}
      }
      nearest[cell]=best;
    },forward=[[-1,0],[-1,-1],[0,-1],[1,-1]],backward=[[1,0],[1,1],[0,1],[-1,1]];
    for(let y=0;y<h;y++)for(let x=0;x<w;x++)visit(x,y,forward);
    for(let y=h-1;y>=0;y--)for(let x=w-1;x>=0;x--)visit(x,y,backward);
    const pixels=field.pixels.data;
    for(let cell=0;cell<cells;cell++){
      let best=0,index=0,second=0,runner=0;const base=cell*this.bins*4;
      for(let bin=0;bin<this.bins;bin++){const i=base+bin*4;if(votes[i]>best){second=best;runner=index;best=votes[i];index=i;}else if(votes[i]>second){second=votes[i];runner=i;}}
      const i=cell*4,photo=centres[nearest[cell]];if(!photo)continue;
      // Different families blend only along their shared overlap, where neither colour clearly wins.
      const t=best?Math.max(0,Math.min(1,(second/best-.55)/.45)):0,mix=t*t*(3-2*t)*.5;
      for(let c=0;c<3;c++)pixels[i+c]=best?Math.round(votes[index+c+1]/best*(1-mix)+(second?votes[runner+c+1]/second*mix:0)):photo.rgb[c];
      pixels[i+3]=255;
    }
    // A narrow overlap at the edges of extrapolated regions removes grid steps without washing out their cores.
    const soft=field.soft||(field.soft=new Float32Array(cells*3)),kernel=[1,4,6,4,1];
    for(let y=0;y<h;y++)for(let x=0;x<w;x++)for(let c=0;c<3;c++){
      let value=0;for(let k=-2;k<=2;k++)value+=pixels[(y*w+Math.max(0,Math.min(w-1,x+k)))*4+c]*kernel[k+2];soft[(y*w+x)*3+c]=value/16;
    }
    for(let y=0;y<h;y++)for(let x=0;x<w;x++)for(let c=0;c<3;c++){
      let value=0;for(let k=-2;k<=2;k++)value+=soft[(Math.max(0,Math.min(h-1,y+k))*w+x)*3+c]*kernel[k+2];pixels[(y*w+x)*4+c]=Math.round(value/16);
    }
    field.ctx.putImageData(field.pixels,0,0);return field;
  }
};
if(typeof module!=="undefined")module.exports=SeaPigments;
