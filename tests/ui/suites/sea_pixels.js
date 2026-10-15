// Compare the tiny-print renderer with native canvas pixels without opening a photo library.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {LINK,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true}),problems=[],runs=[];
  for(const dpr of [1,2]){
    const context=await browser.newContext({viewport:{width:960,height:720},deviceScaleFactor:dpr});
    const page=await context.newPage();page.on('pageerror',e=>problems.push(e.message));
    await page.goto(LINK);await page.waitForFunction(()=>typeof VennSea==='function');
    const result=await page.evaluate(async()=>{
      const W=64,H=48,dpr=devicePixelRatio;
      const panel=document.createElement('section');panel.style.cssText='position:fixed;inset:0;z-index:100000;background:#13202c;color:white;padding:24px;overflow:auto;font:14px monospace';
      panel.innerHTML=`<h2>Tiny photo pixels · DPR ${dpr}</h2><p>Actual / native Canvas reference</p>`;document.body.append(panel);
      const atlas=document.createElement('canvas');atlas.width=atlas.height=32;
      const a=atlas.getContext('2d');
      for(const [x,y,color]of [[0,0,'#f03325'],[16,0,'rgba(30,210,100,.55)'],[0,16,'#2757eb'],[16,16,'#ffd339']]){a.fillStyle=color;a.fillRect(x,y,16,16);}
      // Four distinct cells and asymmetric detail expose wrong atlas offsets and scaling.
      a.fillStyle='#fff';a.fillRect(20,20,4,8);
      const source=i=>({img:atlas,x:i%2*16,y:Math.floor(i/2)*16});
      const sea=Object.assign(Object.create(VennSea.prototype),{el:document.createElement('div'),events:new AbortController(),
        ro:{disconnect(){}},tray:document.createElement('div'),alive:true,kick(){},items:new Map(),sprites:new Map(),tuning:{wobbleDeg:0,dotLod:0,gpu:0},wobbleNow:0});
      const set=(items,highlight=null)=>{
        sea.items=new Map(items.map(it=>[it.id,{density:true,size:8,...it}]));
        // The raster threshold depends on retained photos; invisible placeholders cost no paint calls.
        for(let i=0;i<4001;i++)sea.items.set(10000+i,{id:10000+i,density:false});
        sea.highlightIds=highlight&&new Set(highlight);
        sea.sprites=new Map(items.filter(it=>it.cell!==undefined).map(it=>[it.id,source(it.cell)]));
      };
      const compare=(name)=>{
        sea.drawDensity(W,H);
        const expected=document.createElement('canvas');expected.width=W*dpr;expected.height=H*dpr;
        const ctx=expected.getContext('2d');
        for(const it of sea.items.values())if(it.density&&!it.lifted&&!it.pileLifted){
          const src=sea.sprites.get(it.id)||it.preview;if(!src)continue;
          ctx.globalAlpha=sea.highlightIds&&!sea.highlightIds.has(it.id)?.22:it.cut?.4:.9;
          // Every sprite is the same polaroid card. A raster print is laid out in device pixels (crisp at any DPR):
          // its reference is that geometry, the paper filled natively and the cell scaled natively, unclipped, then
          // placed whole (Chromium resamples a drawImage that the canvas edge clips, or a translated one, a little
          // differently, and that is the browser's artefact, not the raster's). Larger prints take the scaled path.
          const side=Math.round(it.size*dpr);
          if(side<=16){
            ctx.setTransform(1,0,0,1,0,0);
            const g=sea.cardGeometry((it.x-it.size/2)*dpr,(it.y-it.size*2/3)*dpr,side),k=Math.min(g.ww/16,g.wh/16),pw=16*k;
            ctx.fillStyle='#f4efe6';ctx.fillRect(g.x,g.y,g.w,g.h);
            const cell=document.createElement('canvas');cell.width=cell.height=Math.max(1,Math.ceil(pw));
            cell.getContext('2d').drawImage(src.img,src.x,src.y,16,16,0,0,pw,pw);
            ctx.drawImage(cell,g.wx+(g.ww-pw)/2,g.wy);
          }
          else{ctx.setTransform(dpr,0,0,dpr,0,0);sea.drawCard(ctx,src,it.x-it.size/2,it.y-it.size*2/3,it.size,it.id);}
        }
        ctx.setTransform(1,0,0,1,0,0);
        const got=sea.densityCanvas.getContext('2d').getImageData(0,0,W*dpr,H*dpr).data;
        const wanted=ctx.getImageData(0,0,W*dpr,H*dpr).data;
        let maxAlpha=0,maxColor=0,painted=0,where=null,sumColor=0;
        for(let i=0;i<got.length;i+=4){
          maxAlpha=Math.max(maxAlpha,Math.abs(got[i+3]-wanted[i+3]));if(got[i+3])painted++;
          // Compare composited colour: straight RGB is unstable for nearly transparent pixels. The worst pixel is reported.
          let worst=0;
          for(let c=0;c<3;c++){const d=Math.abs(got[i+c]*got[i+3]-wanted[i+c]*wanted[i+3])/255;worst=Math.max(worst,d);if(d>maxColor){maxColor=d;where={x:(i/4)%(W*dpr),y:Math.floor(i/4/(W*dpr)),got:[...got.slice(i,i+4)],wanted:[...wanted.slice(i,i+4)]};}}
          sumColor+=worst;
        }
        const meanColor=sumColor/Math.max(1,painted);
        const row=document.createElement('div');row.style.cssText='display:inline-block;margin:8px 24px 16px 0;vertical-align:top';row.textContent=name;
        for(const image of [sea.densityCanvas,expected]){const copy=document.createElement('canvas');copy.width=image.width;copy.height=image.height;copy.getContext('2d').drawImage(image,0,0);copy.style.cssText='display:inline-block;width:192px;height:144px;margin:8px 4px 0 0;border:1px solid #658;background:#29343f;image-rendering:pixelated';row.append(copy);}
        panel.append(row);
        return {name,maxAlpha,maxColor,meanColor,painted,where,width:sea.densityCanvas.width,height:sea.densityCanvas.height};
      };
      const cases=[];
      set([{id:1,cell:0,x:12,y:12},{id:2,cell:1,x:15,y:14,cut:true},{id:3,cell:2,x:16,y:12},{id:4,cell:3,x:36,y:12}], [1,2,4]);
      cases.push(compare('Atlas cells + overlapping .9 / .4 / .22 opacity'));
      set([{id:1,cell:0,x:0,y:14},{id:2,cell:1,x:W,y:20},{id:3,cell:2,x:24,y:0},{id:4,cell:3,x:38,y:H},
        {id:5,cell:2,x:-20,y:20},{id:6,cell:0,x:W+20,y:30}]);
      cases.push(compare('All four clipped edges + fully outside'));
      set([{id:1,cell:0,x:8,y:8},{id:2,cell:1,x:24,y:8,density:false},{id:3,cell:2,x:40,y:8,lifted:true},{id:4,cell:3,x:56,y:8,pileLifted:true}]);
      cases.push(compare('Promoted, lifted and lifted stack omitted'));
      const hits=[8,24,40,56].map(x=>sea.smallAt(x,8)?.id||null);
      set([{id:1,cell:3,x:44,y:28,size:18},{id:2,cell:2,x:12,y:28,size:4}]);
      cases.push(compare('Large native fallback + tiny print'));
      const beforeFallback=sea.densityTiles.get(atlas).levels.size;
      const fallback=sea.paintTiny(source(0),0,0,17/dpr,.9,dpr);
      const afterFallback=sea.densityTiles.get(atlas).levels.size;
      const preview=async(id,color)=>{
        const tile=document.createElement('canvas');tile.width=tile.height=16;const ctx=tile.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,16,16);
        const img=new Image();img.src=tile.toDataURL();await img.decode();
        const it={id,x:id===1?12:32,y:12,size:8,density:true,el:document.createElement('div')};it.el.append(img);sea.sprites.delete(id);sea.smallPreview(it);return it;  // a print with an atlas cell needs no copy: this one has none
      };
      const first=await preview(1,'#cf28df');set([first]);cases.push(compare('First mutable preview page cell'));
      const cachedVersion=sea.densityTiles.get(first.preview.img).version;
      const second=await preview(2,'#31ddc5');set([first,second]);cases.push(compare('New cell invalidates same preview page'));
      const previewVersion=sea.densityTiles.get(first.preview.img).version;
      const samePreviewPage=first.preview.img===second.preview.img;
      let maxLevels=0;
      for(let side=1;side<=16;side++){sea.paintTiny(source(0),0,0,side/dpr,.9,dpr);maxLevels=Math.max(maxLevels,sea.densityTiles.get(atlas).levels.size);}
      const hadBuffers=!!sea.densityPixels&&!!sea.densityTiles&&!!sea.previewVersions;
      sea.destroy();
      const cleared=!sea.densityPixels&&!sea.densityTiles&&!sea.previewVersions&&!sea.alive;
      return {dpr,cases,hits,fallback,beforeFallback,afterFallback,cachedVersion,previewVersion,samePreviewPage,maxLevels,hadBuffers,cleared};
    });
    // A wrong cell, offset, size or opacity differs by a hundred or more in alpha or colour; the two resamplers of the
    // picture's edges (the browser's and the pre-scaled atlas's) disagree by a dozen on a few boundary pixels.
    for(const check of result.cases){assert(check.painted>0,JSON.stringify(check));assert(check.maxAlpha<=2&&check.maxColor<=16&&check.meanColor<=1,JSON.stringify({dpr,...check}));assert.equal(check.width,64*dpr);assert.equal(check.height,48*dpr);}
    assert.deepEqual(result.hits,[1,null,null,null]);assert.equal(result.fallback,false);assert.equal(result.beforeFallback,result.afterFallback);
    assert(result.samePreviewPage&&result.previewVersion>result.cachedVersion,JSON.stringify(result));
    assert(result.maxLevels<=3&&result.hadBuffers&&result.cleared,JSON.stringify(result));
    await page.screenshot({path:`${OUT}/pixels-dpr${dpr}.png`});runs.push(result);await context.close();
  }
  assert.deepEqual(problems,[]);console.log(JSON.stringify({runs,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
