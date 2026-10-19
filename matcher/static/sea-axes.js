// Axis names and measurements are shared by the controls and the worker; changing a view never edits a photo.
const SeaAxes={
  defaults:{x:'colorfulness',y:'brightness',reverseX:false,reverseY:false},
  options:[
    {key:'colorfulness',label:'Colourfulness',low:'muted',high:'colourful',unit:true},
    {key:'brightness',label:'Brightness',low:'dark',high:'bright',unit:true},
    {key:'hue',label:'Hue',low:'0°',high:'360°',unit:true},
    {key:'saturation',label:'Saturation',low:'soft',high:'vivid',unit:true},
    {key:'date',label:'Capture date',low:'oldest',high:'newest'},
    {key:'quality',label:'Photo quality',low:'lower',high:'higher'},
    {key:'ranking',label:'Your ranking',low:'lower',high:'higher'},
    {key:'sharpness',label:'Sharpness',low:'soft',high:'sharp'},
    {key:'aspect',label:'Aspect ratio',low:'portrait',high:'landscape'},
    {key:'faces',label:'Faces',low:'fewer',high:'more'}
  ],
  normalize(value){
    const keys=this.options.map(o=>o.key),v=value||{};
    return {x:keys.includes(v.x)?v.x:this.defaults.x,y:keys.includes(v.y)?v.y:this.defaults.y,reverseX:v.reverseX===true,reverseY:v.reverseY===true};
  },
  value(it,key){
    const value=key==='colorfulness'?(it.visual?.colorfulness??it.visual?.saturation):['brightness','hue','saturation'].includes(key)?it.visual?.[key]:it.measurements?.[key];
    return Number.isFinite(value)?value:null;
  },
  label(key){return this.options.find(o=>o.key===key)?.label||'';},
  equal(a,b){return JSON.stringify(this.normalize(a))===JSON.stringify(this.normalize(b));}
};
if(typeof module!=="undefined")module.exports=SeaAxes;
