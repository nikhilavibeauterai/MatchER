// Colour voting is the same calculation as the canvas fallback, away from the pointer and camera thread.
importScripts('/static/sea-pigments.js');
let field;
self.onmessage=({data:job})=>{
  const start=performance.now();field=SeaPigments.field(job.spots,job.W,job.H,job.camera,field);
  const pixels=field.pixels.data.slice();
  self.postMessage({key:job.key,w:field.w,h:field.h,pixels,ms:performance.now()-start},[pixels.buffer]);
};
